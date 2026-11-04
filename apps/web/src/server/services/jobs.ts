/**
 * Background jobs (Story 5.1): lifecycle, persisted events, SSE with resume, cancel, reaping.
 *
 * Lifecycle: queued → provisioning → running → succeeded | failed | cancelled.
 * Every transition and progress report is a job_events row with a per-job seq (1-based), so a
 * client that closes the tab can come back and replay from Last-Event-ID. The runner (Vercel
 * Sandbox) is injected, so tests and local dev use a fake.
 */
import { assertCan } from '@crunch/authz';
import { encodeSse, SSE_KEEPALIVE } from '@crunch/agent';
import {
  jobInputs,
  TERMINAL_STATUSES,
  type JobEvent,
  type JobEventType,
  type JobKind,
  type JobRunner,
  type JobStatus,
} from '@crunch/contracts';
import {
  agentConversations,
  agentMessages,
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  jobEvents,
  jobs,
  jobTokens,
  lt,
  members,
  sql,
  workspaces,
  type Db,
  type JobRow,
} from '@crunch/db';
import { z } from 'zod';
import { revokeJobTokens, verifyJobToken, JobTokenError } from './agent/job-tokens';
import { getProject } from './projects';
import { NotFoundError, ValidationError, type Actor } from './types';

export const DEFAULT_JOB_TIMEOUT_SECONDS = 30 * 60;
export const DEFAULT_MAX_ATTEMPTS = 2;
/** A running job that hasn't shown activity for this long is presumed orphaned. */
export const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;
/** How long provisioning (sandbox create + spawn) may take before the reaper steps in. */
export const PROVISION_TIMEOUT_MS = 10 * 60 * 1000;
/** Heartbeats from the proxy and tool calls are written at most this often. */
export const HEARTBEAT_THROTTLE_MS = 30 * 1000;

export interface JobDeps {
  runner: JobRunner;
  now?: () => Date;
  maxAttempts?: number;
  heartbeatTimeoutMs?: number;
}

const LLM_KINDS = new Set<JobKind>(['codegen', 'figma_export']);

export interface JobView {
  id: string;
  kind: JobKind;
  status: JobStatus;
  projectId: string | null;
  conversationId: string | null;
  input: unknown;
  result: unknown;
  error: string | null;
  attempts: number;
  lastEventSeq: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export const toJobView = (j: JobRow): JobView => ({
  id: j.id,
  kind: j.kind,
  status: j.status,
  projectId: j.projectId,
  conversationId: j.conversationId,
  input: j.input,
  result: j.result,
  error: j.error,
  attempts: j.attempts,
  lastEventSeq: j.lastEventSeq,
  createdAt: j.createdAt.toISOString(),
  startedAt: j.startedAt?.toISOString() ?? null,
  finishedAt: j.finishedAt?.toISOString() ?? null,
});

// ---------------------------------------------------------------------------------------------
// Events and transitions
// ---------------------------------------------------------------------------------------------

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function appendEventTx(
  tx: Tx | Db,
  jobId: string,
  type: JobEventType,
  data: Record<string, unknown>,
): Promise<number> {
  const [row] = await tx
    .update(jobs)
    .set({ lastEventSeq: sql`${jobs.lastEventSeq} + 1` })
    .where(eq(jobs.id, jobId))
    .returning({ seq: jobs.lastEventSeq });
  if (!row) throw new NotFoundError('Job not found');
  await tx.insert(jobEvents).values({ jobId, seq: row.seq, type, data });
  return row.seq;
}

/** Append an event with the next seq for the job (atomic per job). */
export async function appendJobEvent(
  db: Db,
  jobId: string,
  type: JobEventType,
  data: Record<string, unknown> = {},
): Promise<number> {
  return db.transaction((tx) => appendEventTx(tx, jobId, type, data));
}

/**
 * Record activity for a live job, at most every HEARTBEAT_THROTTLE_MS. Called from sandbox
 * reports, the LLM proxy (during long streams) and MCP tool calls, so a long model turn doesn't
 * look like a dead sandbox to the reaper.
 */
export async function touchJobHeartbeat(db: Db, jobId: string, now = new Date()): Promise<void> {
  await db
    .update(jobs)
    .set({ heartbeatAt: now })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.status, 'running'),
        sql`(${jobs.heartbeatAt} is null or ${jobs.heartbeatAt} < ${new Date(now.getTime() - HEARTBEAT_THROTTLE_MS)})`,
      ),
    );
}

interface TransitionExtras {
  /** Events written before the status event, in the same transaction. */
  events?: { type: JobEventType; data: Record<string, unknown> }[];
  /** Status event payload. */
  eventData?: Record<string, unknown>;
  /** Final chat text for the job's message (terminal transitions). */
  messageText?: string;
}

/**
 * Conditional status change: only from one of `from`. The status row, its events, token
 * revocation and the chat message are written in one transaction, so an SSE reader never sees a
 * terminal status without its final events, and `done` can't precede them.
 */
async function transition(
  db: Db,
  jobId: string,
  from: JobStatus[],
  to: JobStatus,
  patch: Partial<typeof jobs.$inferInsert> = {},
  extras: TransitionExtras = {},
): Promise<JobRow | null> {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(jobs)
      .set({ status: to, ...patch })
      .where(and(eq(jobs.id, jobId), inArray(jobs.status, from)))
      .returning();
    if (!updated) return null;
    for (const e of extras.events ?? []) await appendEventTx(tx, jobId, e.type, e.data);
    await appendEventTx(tx, jobId, 'status', { status: to, ...extras.eventData });
    if (TERMINAL_STATUSES.has(to)) {
      await tx
        .update(jobTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(jobTokens.jobId, jobId), isNull(jobTokens.revokedAt)));
      const status = to === 'succeeded' ? 'complete' : to === 'cancelled' ? 'cancelled' : 'error';
      await tx
        .update(agentMessages)
        .set({
          status,
          error: to === 'failed' ? (updated.error ?? 'Job failed') : null,
          ...(extras.messageText !== undefined
            ? {
                content: {
                  v: 1,
                  turns: [
                    { role: 'assistant', content: [{ type: 'text', text: extras.messageText }] },
                  ],
                },
              }
            : {}),
        })
        .where(
          and(
            eq(agentMessages.jobId, jobId),
            inArray(agentMessages.status, ['pending', 'streaming']),
          ),
        );
    }
    const [row] = await tx.select().from(jobs).where(eq(jobs.id, jobId));
    return row ?? updated;
  });
}

/** Whether a job's agent has already committed document changes (a retry would duplicate them). */
export async function jobHasCommitted(db: Db, jobId: string): Promise<boolean> {
  const rows = await db
    .select({ n: sql<number>`coalesce(cardinality(${agentMessages.txnIds}), 0)::int` })
    .from(agentMessages)
    .where(eq(agentMessages.jobId, jobId));
  return rows.some((r) => r.n > 0);
}

// ---------------------------------------------------------------------------------------------
// Create / start / cancel
// ---------------------------------------------------------------------------------------------

export const createJobInput = z
  .object({
    kind: z.enum(Object.keys(jobInputs) as [JobKind, ...JobKind[]]),
    input: z.unknown(),
    projectId: z.uuid().optional(),
    conversationId: z.uuid().optional(),
    /** Assistant message the job reports into (its transactions are attributed to it). */
    messageId: z.uuid().optional(),
    timeoutSeconds: z
      .number()
      .int()
      .min(60)
      .max(24 * 3600)
      .optional(),
  })
  .strict();

export async function createJob(db: Db, actor: Actor, raw: unknown): Promise<JobRow> {
  assertCan(actor.role, 'agent:run');
  const parsed = createJobInput.safeParse(raw);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid job');
  const { kind, projectId, conversationId, messageId, timeoutSeconds } = parsed.data;
  if (LLM_KINDS.has(kind)) assertCan(actor.role, 'export:llm');
  const input = jobInputs[kind].safeParse(parsed.data.input);
  if (!input.success)
    throw new ValidationError(`Invalid ${kind} input: ${input.error.issues[0]?.message ?? ''}`);
  if (projectId) await getProject(db, actor, projectId);
  if ((conversationId || messageId) && !projectId)
    throw new ValidationError('A job linked to a conversation needs a projectId');

  const job = await db.transaction(async (tx) => {
    if (conversationId) {
      const [conv] = await tx
        .select({ id: agentConversations.id })
        .from(agentConversations)
        .where(
          and(
            eq(agentConversations.id, conversationId),
            eq(agentConversations.workspaceId, actor.workspace.id),
            eq(agentConversations.projectId, projectId!),
          ),
        )
        .limit(1);
      if (!conv) throw new ValidationError('Conversation not found in this project');
    }
    const [row] = await tx
      .insert(jobs)
      .values({
        workspaceId: actor.workspace.id,
        projectId: projectId ?? null,
        conversationId: conversationId ?? null,
        kind,
        input: input.data,
        timeoutSeconds: timeoutSeconds ?? DEFAULT_JOB_TIMEOUT_SECONDS,
        createdBy: actor.userId,
      })
      .returning();
    if (messageId) {
      // Only an unlinked assistant message in this project's conversation (and in the given
      // conversation, if any) can carry the job's edits, snapshot and summary.
      const linked = await tx
        .update(agentMessages)
        .set({ jobId: row!.id })
        .where(
          and(
            eq(agentMessages.id, messageId),
            eq(agentMessages.workspaceId, actor.workspace.id),
            eq(agentMessages.role, 'assistant'),
            isNull(agentMessages.jobId),
            conversationId ? eq(agentMessages.conversationId, conversationId) : undefined,
            inArray(
              agentMessages.conversationId,
              tx
                .select({ id: agentConversations.id })
                .from(agentConversations)
                .where(eq(agentConversations.projectId, projectId!)),
            ),
          ),
        )
        .returning({ id: agentMessages.id });
      if (!linked.length)
        throw new ValidationError(
          'messageId must be an assistant message in this project that is not linked to a job',
        );
    }
    return row!;
  });
  await appendJobEvent(db, job.id, 'status', { status: 'queued' });
  return job;
}

/** Provision a sandbox for a queued job. Safe to call twice (only one caller wins). */
export async function startJob(db: Db, jobId: string, deps: JobDeps): Promise<JobRow | null> {
  const now = deps.now?.() ?? new Date();
  // heartbeatAt marks when provisioning began; the reaper leaves it alone until PROVISION_TIMEOUT_MS.
  const claimed = await transition(db, jobId, ['queued'], 'provisioning', {
    attempts: sql`${jobs.attempts} + 1` as unknown as number,
    heartbeatAt: now,
  });
  if (!claimed) return null;
  try {
    const { sandboxId } = await deps.runner.start({
      jobId,
      workspaceId: claimed.workspaceId,
      kind: claimed.kind,
      input: claimed.input,
      timeoutSeconds: claimed.timeoutSeconds,
    });
    // A cancel may have landed while provisioning: stop the new sandbox straight away.
    const running = await transition(db, jobId, ['provisioning'], 'running', {
      sandboxId,
      startedAt: now,
      heartbeatAt: now,
    });
    if (!running) await deps.runner.cancel(jobId, sandboxId).catch(() => {});
    return running;
  } catch (e) {
    const message =
      e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : 'Failed to start';
    const max = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (claimed.attempts < max) {
      await appendJobEvent(db, jobId, 'log', { text: `Start failed, will retry: ${message}` });
      return transition(db, jobId, ['provisioning'], 'queued');
    }
    return transition(db, jobId, ['provisioning'], 'failed', { error: message, finishedAt: now });
  }
}

async function loadJob(db: Db, actor: Actor, jobId: string): Promise<JobRow> {
  if (!z.uuid().safeParse(jobId).success) throw new NotFoundError('Job not found');
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.workspaceId, actor.workspace.id)))
    .limit(1);
  if (!job) throw new NotFoundError('Job not found');
  return job;
}

export async function getJob(db: Db, actor: Actor, jobId: string): Promise<JobView> {
  assertCan(actor.role, 'project:read');
  return toJobView(await loadJob(db, actor, jobId));
}

export async function cancelJob(
  db: Db,
  actor: Actor,
  jobId: string,
  deps: JobDeps,
): Promise<JobView> {
  assertCan(actor.role, 'agent:run');
  const job = await loadJob(db, actor, jobId);
  if (TERMINAL_STATUSES.has(job.status)) return toJobView(job);
  const now = deps.now?.() ?? new Date();
  await db.update(jobs).set({ cancelRequestedAt: now }).where(eq(jobs.id, jobId));
  const row = await transition(
    db,
    jobId,
    ['queued', 'provisioning', 'running'],
    'cancelled',
    { finishedAt: now },
    { eventData: { by: actor.userId } },
  );
  if (job.sandboxId) await deps.runner.cancel(jobId, job.sandboxId).catch(() => {});
  return toJobView(row ?? (await loadJob(db, actor, jobId)));
}

/** The chat text for a finished job: the agent's summary plus the frames it created (Story 5.5 AC). */
export function jobSummaryText(result: { summary: string; frames: unknown[] }): string {
  const names = result.frames
    .map((f) => (f as { name?: unknown }).name)
    .filter((n): n is string => typeof n === 'string');
  const created = names.length
    ? `\n\nCreated ${names.length === 1 ? '1 frame' : `${names.length} frames`}: ${names.join(', ')}.`
    : '';
  return `${result.summary || 'Job finished.'}${created}`.trim();
}

// ---------------------------------------------------------------------------------------------
// Reports from the sandbox (job-token auth)
// ---------------------------------------------------------------------------------------------

const reportBody = z
  .object({
    // Only the server sets job status; sandboxes report progress, logs, tools, result or error.
    type: z.enum(['progress', 'log', 'tool', 'result', 'error']),
    data: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export class JobGoneError extends Error {
  override name = 'JobGoneError';
}

/** POST /api/jobs/:id/report. Returns the stored event's seq. */
export async function reportJobEvent(
  db: Db,
  token: string | null,
  jobId: string,
  raw: unknown,
  opts: { now?: () => Date } = {},
): Promise<{ seq: number }> {
  const job = await verifyJobToken(db, token);
  if (job.id !== jobId) throw new JobTokenError('Token is for a different job');
  const parsed = reportBody.safeParse(raw);
  if (!parsed.success) throw new ValidationError('Invalid report');
  const now = opts.now?.() ?? new Date();
  const { type, data } = parsed.data;
  const json = JSON.stringify(data);
  const clipped: Record<string, unknown> =
    json.length <= 20_000 ? data : { truncated: true, preview: json.slice(0, 2000) };
  await db.update(jobs).set({ heartbeatAt: now }).where(eq(jobs.id, jobId));

  if (type === 'result') {
    const frames = await db
      .select({ data: jobEvents.data })
      .from(jobEvents)
      .where(and(eq(jobEvents.jobId, jobId), eq(jobEvents.type, 'frame')))
      .orderBy(asc(jobEvents.seq));
    const result = { summary: String(clipped.summary ?? ''), frames: frames.map((f) => f.data) };
    // Only recorded if the job is still running: a result that races a cancel is dropped.
    const row = await transition(
      db,
      jobId,
      ['running'],
      'succeeded',
      { result, finishedAt: now },
      { events: [{ type: 'result', data: clipped }], messageText: jobSummaryText(result) },
    );
    if (!row) throw new JobGoneError('Job is no longer running');
    return { seq: row.lastEventSeq };
  }
  if (type === 'error') {
    const row = await transition(
      db,
      jobId,
      ['running'],
      'failed',
      { error: String(clipped.message ?? 'Job failed').slice(0, 500), finishedAt: now },
      { events: [{ type: 'error', data: clipped }] },
    );
    if (!row) throw new JobGoneError('Job is no longer running');
    return { seq: row.lastEventSeq };
  }
  return { seq: await appendJobEvent(db, jobId, type, clipped) };
}

// ---------------------------------------------------------------------------------------------
// Reaper (cron): timeouts, orphaned sandboxes, retries, stuck queue
// ---------------------------------------------------------------------------------------------

export interface ReapSummary {
  timedOut: string[];
  orphaned: string[];
  retried: string[];
  started: string[];
}

export async function reapJobs(db: Db, deps: JobDeps): Promise<ReapSummary> {
  const now = deps.now?.() ?? new Date();
  const hbTimeout = deps.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  const max = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const out: ReapSummary = { timedOut: [], orphaned: [], retried: [], started: [] };

  const active = await db
    .select()
    .from(jobs)
    .where(inArray(jobs.status, ['provisioning', 'running']))
    .limit(500);
  for (const job of active) {
    if (job.status === 'provisioning') {
      // No sandbox id yet: leave it alone until its provisioning deadline passes.
      const since = (job.heartbeatAt ?? job.updatedAt).getTime();
      if (since + PROVISION_TIMEOUT_MS >= now.getTime()) continue;
    } else {
      const started = job.startedAt ?? job.updatedAt;
      if (started.getTime() + job.timeoutSeconds * 1000 < now.getTime()) {
        if (job.sandboxId) await deps.runner.cancel(job.id, job.sandboxId).catch(() => {});
        await transition(db, job.id, ['running'], 'failed', {
          error: `Timed out after ${job.timeoutSeconds}s`,
          finishedAt: now,
        });
        out.timedOut.push(job.id);
        continue;
      }
      const stale = (job.heartbeatAt ?? job.updatedAt).getTime() + hbTimeout < now.getTime();
      const alive = job.sandboxId ? await deps.runner.isAlive(job.sandboxId) : false;
      if (!stale && alive) continue;
      if (alive && job.sandboxId) await deps.runner.cancel(job.id, job.sandboxId).catch(() => {});
    }
    // Lost. Retry from scratch only if nothing was committed yet, so a retry can't duplicate
    // frames (or the spend that produced them).
    const committed = await jobHasCommitted(db, job.id);
    if (job.attempts < max && !committed) {
      const requeued = await transition(
        db,
        job.id,
        [job.status],
        'queued',
        { sandboxId: null },
        {
          events: [{ type: 'log', data: { text: 'Sandbox lost; retrying' } }],
        },
      );
      if (requeued) {
        await revokeJobTokens(db, job.id);
        out.retried.push(job.id);
      }
    } else {
      const failed = await transition(db, job.id, [job.status], 'failed', {
        error: committed
          ? 'The job stopped after making changes, so it was not retried. Revert or start it again.'
          : job.status === 'provisioning'
            ? 'The job sandbox did not start in time'
            : 'The job sandbox stopped unexpectedly',
        finishedAt: now,
      });
      if (failed) out.orphaned.push(job.id);
    }
  }

  const queued = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.status, 'queued'), lt(jobs.updatedAt, new Date(now.getTime() - 15_000))))
    .limit(50);
  for (const { id } of queued) if (await startJob(db, id, deps)) out.started.push(id);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Event stream (SSE with Last-Event-ID resume)
// ---------------------------------------------------------------------------------------------

export async function listJobEvents(
  db: Db,
  actor: Actor,
  jobId: string,
  afterSeq = 0,
  limit = 500,
): Promise<JobEvent[]> {
  assertCan(actor.role, 'project:read');
  await loadJob(db, actor, jobId);
  const rows = await db
    .select()
    .from(jobEvents)
    .where(and(eq(jobEvents.jobId, jobId), gt(jobEvents.seq, afterSeq)))
    .orderBy(asc(jobEvents.seq))
    .limit(limit);
  return rows.map((r) => ({
    seq: r.seq,
    type: r.type as JobEventType,
    data: r.data as Record<string, unknown>,
    createdAt: r.createdAt.toISOString(),
  }));
}

export function parseLastEventId(header: string | null, query: string | null): number {
  const n = Number(header ?? query ?? 0);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * SSE frames for a job: every event after `afterSeq` (id = seq), polling for new ones until the
 * job is terminal and drained, then `done`. Ends after maxMs; EventSource resumes from the last id.
 */
export async function* jobEventFrames(
  db: Db,
  actor: Actor,
  jobId: string,
  afterSeq: number,
  opts: { signal?: AbortSignal; pollMs?: number; maxMs?: number; keepaliveMs?: number } = {},
): AsyncGenerator<string> {
  let seq = afterSeq;
  const deadline = Date.now() + (opts.maxMs ?? 240_000);
  const keepaliveMs = opts.keepaliveMs ?? 15_000;
  let lastSent = Date.now();
  yield encodeSse({ retry: 2000, event: 'open', data: { jobId, after: afterSeq } });
  while (!opts.signal?.aborted) {
    const events = await listJobEvents(db, actor, jobId, seq);
    for (const e of events) {
      seq = e.seq;
      lastSent = Date.now();
      yield encodeSse({ id: e.seq, event: e.type, data: e });
    }
    if (!events.length) {
      const [job] = await db
        .select({ status: jobs.status, last: jobs.lastEventSeq })
        .from(jobs)
        .where(eq(jobs.id, jobId));
      if (job && TERMINAL_STATUSES.has(job.status) && job.last <= seq) {
        yield encodeSse({ event: 'done', data: { status: job.status } });
        return;
      }
      if (Date.now() > deadline) return;
      if (Date.now() - lastSent > keepaliveMs) {
        lastSent = Date.now();
        yield SSE_KEEPALIVE;
      }
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 1000));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The job's acting user (tools run with the creator's current role)
// ---------------------------------------------------------------------------------------------

export async function jobActor(db: Db, job: JobRow): Promise<Actor> {
  const [row] = await db
    .select({ workspace: workspaces, role: members.role })
    .from(members)
    .innerJoin(workspaces, eq(workspaces.id, members.workspaceId))
    .where(and(eq(members.workspaceId, job.workspaceId), eq(members.userId, job.createdBy)))
    .limit(1);
  if (!row) throw new JobTokenError('The job owner is no longer a member of this workspace');
  return { userId: job.createdBy, role: row.role, workspace: row.workspace };
}
