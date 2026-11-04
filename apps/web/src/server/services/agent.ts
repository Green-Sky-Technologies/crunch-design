/**
 * Interactive agent (Stories 5.4, 5.6): conversations, messages, running a turn, and the
 * per-message SSE stream.
 *
 * A turn runs after the POST responds (route handlers use `after()`), and writes its progress to
 * agent_messages as it streams. The SSE endpoint polls that row, so a reconnect, a second tab or
 * another function instance all see the same state, and closing the tab doesn't stop the run.
 * Cancel flips the row's status; the running turn notices and aborts its model call.
 */
import { assertCan } from '@crunch/authz';
import {
  buildPrefix,
  buildTurnContext,
  detectJobRequest,
  encodeSse,
  ModelNotAllowedError,
  prefixCacheTtl,
  resolveModel,
  runAgentTurn,
  SSE_KEEPALIVE,
  type Anthropic,
  type JobSuggestion,
  type ToolActivity,
  type TurnUpdate,
} from '@crunch/agent';
import {
  agentConversations,
  agentMessages,
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  sql,
  type AgentMessageRow,
  type Db,
} from '@crunch/db';
import { z } from 'zod';
import { getDoc, LockedError } from './design-docs';
import { resolveProjectDesignSystem } from './project-design-system';
import { getProject } from './projects';
import { getModelSettings } from './agent/model-settings';
import { snapshotBeforeAgentEdit } from './agent/snapshots';
import { settleStaleMessages } from './agent/stale';
import { createDbToolHost } from './agent/tool-host';
import { ProviderError, streamModel, type LlmProxyDeps } from './llm-proxy';
import { NotFoundError, ValidationError, type Actor } from './types';

// ---------------------------------------------------------------------------------------------
// Stored shapes (agent_messages.content)
// ---------------------------------------------------------------------------------------------

export interface TurnContextRef {
  selection?: string[];
  frameId?: string | null;
  scopeNodeId?: string;
}

/** User message: what they typed, and the exact API turn sent (context + prompt). */
export interface StoredUserContent {
  v: 1;
  prompt: string;
  context: TurnContextRef;
  turns: Anthropic.MessageParam[];
}

/** Assistant message: API turns (text, tool use, tool results), plus UI state while streaming. */
export interface StoredAssistantContent {
  v: 1;
  turns: Anthropic.MessageParam[];
  partial?: Anthropic.ContentBlockParam[] | null;
  activity?: ToolActivity[];
  touched?: string[];
  jobSuggestion?: JobSuggestion | null;
  stopReason?: string | null;
}

export type Attachment =
  | { type: 'image'; url: string }
  | { type: 'url'; url: string }
  | { type: 'figma'; fileKey: string; nodeId: string };

export const attachmentSchema: z.ZodType<Attachment> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('image'), url: z.url({ protocol: /^https$/ }).max(2048) }).strict(),
  z.object({ type: z.literal('url'), url: z.url({ protocol: /^https?$/ }).max(2048) }).strict(),
  z
    .object({ type: z.literal('figma'), fileKey: z.string().max(64), nodeId: z.string().max(64) })
    .strict(),
]);

export interface MessageView {
  id: string;
  conversationId: string;
  seq: number;
  role: 'user' | 'assistant' | 'system';
  status: AgentMessageRow['status'];
  model: string | null;
  /** User prompt, or the assistant's text so far. */
  text: string;
  activity: ToolActivity[];
  touched: string[];
  txnIds: string[];
  jobSuggestion: JobSuggestion | null;
  /** User messages: the selection/frame the prompt was sent with (retry reuses it). */
  context: TurnContextRef | null;
  jobId: string | null;
  snapshotVersionId: string | null;
  attachments: Attachment[];
  error: string | null;
  createdAt: string;
}

const TERMINAL = new Set<AgentMessageRow['status']>(['complete', 'error', 'cancelled']);

function blocksText(blocks: (string | Anthropic.ContentBlockParam)[]): string[] {
  return blocks.map((b) => (typeof b === 'string' ? b : b.type === 'text' ? b.text : ''));
}

export function toMessageView(row: AgentMessageRow): MessageView {
  const base = {
    id: row.id,
    conversationId: row.conversationId,
    seq: row.seq,
    role: row.role,
    status: row.status,
    model: row.model,
    txnIds: row.txnIds,
    jobId: row.jobId,
    snapshotVersionId: row.snapshotVersionId,
    attachments: (row.attachments ?? []) as Attachment[],
    error: row.error,
    createdAt: row.createdAt.toISOString(),
  };
  if (row.role === 'user') {
    const c = row.content as StoredUserContent;
    return {
      ...base,
      text: c.prompt ?? '',
      activity: [],
      touched: [],
      jobSuggestion: null,
      context: c.context ?? null,
    };
  }
  const c = (row.content ?? { v: 1, turns: [] }) as StoredAssistantContent;
  const texts = (c.turns ?? [])
    .filter((t) => t.role === 'assistant')
    .flatMap((t) => blocksText(typeof t.content === 'string' ? [t.content] : t.content));
  if (c.partial) texts.push(...blocksText(c.partial));
  return {
    ...base,
    text: texts.filter(Boolean).join('\n\n'),
    activity: c.activity ?? [],
    touched: c.touched ?? [],
    jobSuggestion: c.jobSuggestion ?? null,
    context: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Conversations and messages
// ---------------------------------------------------------------------------------------------

async function loadConversation(db: Db, actor: Actor, conversationId: string) {
  if (!z.uuid().safeParse(conversationId).success)
    throw new NotFoundError('Conversation not found');
  const [conv] = await db
    .select()
    .from(agentConversations)
    .where(
      and(
        eq(agentConversations.id, conversationId),
        eq(agentConversations.workspaceId, actor.workspace.id),
      ),
    )
    .limit(1);
  if (!conv) throw new NotFoundError('Conversation not found');
  return conv;
}

export async function loadMessage(db: Db, actor: Actor, messageId: string) {
  if (!z.uuid().safeParse(messageId).success) throw new NotFoundError('Message not found');
  const [row] = await db
    .select()
    .from(agentMessages)
    .where(and(eq(agentMessages.id, messageId), eq(agentMessages.workspaceId, actor.workspace.id)))
    .limit(1);
  if (!row) throw new NotFoundError('Message not found');
  return row;
}

/** The project's main chat (unscoped), with its messages. */
/** Interactive turns stop themselves after this (the messages route allows 300s). */
export const TURN_DEADLINE_MS = 270_000;
const TIMEOUT_ERROR = 'The reply took too long and was stopped.';
export { settleStaleMessages, STALE_TURN_MS } from './agent/stale';

export async function getProjectChat(
  db: Db,
  actor: Actor,
  projectId: string,
): Promise<{ conversationId: string | null; messages: MessageView[] }> {
  assertCan(actor.role, 'project:read');
  await getProject(db, actor, projectId);
  const [conv] = await db
    .select()
    .from(agentConversations)
    .where(
      and(
        eq(agentConversations.projectId, projectId),
        eq(agentConversations.workspaceId, actor.workspace.id),
        isNull(agentConversations.commentThreadId),
        sql`${agentConversations.scope} is null`,
      ),
    )
    .orderBy(desc(agentConversations.updatedAt))
    .limit(1);
  if (!conv) return { conversationId: null, messages: [] };
  await settleStaleMessages(db, { conversationId: conv.id });
  return { conversationId: conv.id, messages: await listMessages(db, actor, conv.id) };
}

export async function listMessages(
  db: Db,
  actor: Actor,
  conversationId: string,
): Promise<MessageView[]> {
  assertCan(actor.role, 'project:read');
  await loadConversation(db, actor, conversationId);
  const rows = await db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.conversationId, conversationId))
    .orderBy(asc(agentMessages.seq));
  return rows.map(toMessageView);
}

export const sendMessageInput = z
  .object({
    projectId: z.uuid(),
    conversationId: z.uuid().optional(),
    prompt: z.string().trim().min(1).max(8000),
    model: z.string().max(100).optional(),
    selection: z.array(z.string().max(64)).max(50).optional(),
    frameId: z.string().max(64).nullish(),
    attachments: z.array(attachmentSchema).max(10).optional(),
  })
  .strict();
export type SendMessageInput = z.infer<typeof sendMessageInput>;

export interface SentMessage {
  conversationId: string;
  userMessageId: string;
  messageId: string;
  /** False when the reply was produced without a model call (job offer). */
  needsRun: boolean;
}

/**
 * The persisted user turn: attachments + prompt, never the document. The current document
 * context is attached only to the newest user message when the turn runs (SPEC §2.3), so
 * history doesn't replay a full <document> per past turn.
 */
function userTurnFor(prompt: string, attachments: Attachment[]): Anthropic.MessageParam {
  const content: Anthropic.ContentBlockParam[] = [];
  for (const a of attachments) {
    if (a.type === 'image') content.push({ type: 'image', source: { type: 'url', url: a.url } });
    else if (a.type === 'url')
      content.push({ type: 'text', text: `Attached web page (reference): ${a.url}` });
    else
      content.push({
        type: 'text',
        text: `Attached Figma frame: file ${a.fileKey}, node ${a.nodeId}`,
      });
  }
  content.push({ type: 'text', text: prompt });
  return { role: 'user', content };
}

const JOB_OFFER_TEXT: Record<JobSuggestion['kind'], string> = {
  generate: 'That needs new frames, so it runs as a background generation job. Start it below.',
  redesign: 'A redesign rewrites whole frames, so it runs as a background job. Start it below.',
  alternatives: 'Alternatives are built as sibling frames in a background job. Start it below.',
};

/**
 * Append a user message and a pending assistant reply. The caller runs the reply with
 * `runAssistantMessage` (after the response) unless `needsRun` is false.
 */
export async function sendMessage(
  db: Db,
  actor: Actor,
  raw: unknown,
  opts: {
    scope?: TurnContextRef & { scopeNodeId: string; frameId: string; allowWider: boolean };
    commentThreadId?: string;
  } = {},
): Promise<SentMessage> {
  assertCan(actor.role, 'agent:run');
  const parsed = sendMessageInput.safeParse(raw);
  if (!parsed.success)
    throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid message');
  const input = parsed.data;
  await getProject(db, actor, input.projectId);

  let model: string;
  try {
    model = resolveModel(
      await getModelSettings(db, actor.workspace.id),
      'interactive',
      input.model,
    );
  } catch (e) {
    if (e instanceof ModelNotAllowedError) throw new ValidationError(e.message);
    throw e;
  }

  const contextRef: TurnContextRef = opts.scope
    ? { scopeNodeId: opts.scope.scopeNodeId, frameId: opts.scope.frameId }
    : { selection: input.selection, frameId: input.frameId ?? null };
  const attachments = input.attachments ?? [];
  const userTurn = userTurnFor(input.prompt, attachments);
  const detected = opts.scope ? null : detectJobRequest(input.prompt);

  return db.transaction(async (tx) => {
    let conversationId = input.conversationId;
    if (conversationId) {
      const [conv] = await tx
        .select()
        .from(agentConversations)
        .where(
          and(
            eq(agentConversations.id, conversationId),
            eq(agentConversations.workspaceId, actor.workspace.id),
            eq(agentConversations.projectId, input.projectId),
          ),
        )
        .for('update')
        .limit(1);
      if (!conv) throw new NotFoundError('Conversation not found');
    } else {
      const [conv] = await tx
        .insert(agentConversations)
        .values({
          workspaceId: actor.workspace.id,
          projectId: input.projectId,
          title: input.prompt.slice(0, 80),
          scope: opts.scope
            ? {
                nodeId: opts.scope.scopeNodeId,
                frameId: opts.scope.frameId,
                allowWider: opts.scope.allowWider,
              }
            : null,
          commentThreadId: opts.commentThreadId ?? null,
          createdBy: actor.userId,
        })
        .returning();
      conversationId = conv!.id;
    }
    const [{ max }] = (await tx
      .select({ max: sql<number>`coalesce(max(${agentMessages.seq}), 0)::int` })
      .from(agentMessages)
      .where(eq(agentMessages.conversationId, conversationId))) as [{ max: number }];

    const userContent: StoredUserContent = {
      v: 1,
      prompt: input.prompt,
      context: contextRef,
      turns: [userTurn],
    };
    const [user] = await tx
      .insert(agentMessages)
      .values({
        conversationId,
        workspaceId: actor.workspace.id,
        seq: max + 1,
        role: 'user',
        content: userContent,
        attachments,
        status: 'complete',
        createdBy: actor.userId,
      })
      .returning();

    const suggestion: JobSuggestion | null = detected
      ? {
          kind: detected.kind,
          prompt: input.prompt,
          count: detected.count,
          frameIds: detected.kind === 'redesign' && input.frameId ? [input.frameId] : undefined,
          reason: 'Detected a generation request',
        }
      : null;
    const assistantContent: StoredAssistantContent = suggestion
      ? {
          v: 1,
          turns: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: JOB_OFFER_TEXT[suggestion.kind] }],
            },
          ],
          jobSuggestion: suggestion,
        }
      : { v: 1, turns: [] };
    const [assistant] = await tx
      .insert(agentMessages)
      .values({
        conversationId,
        workspaceId: actor.workspace.id,
        seq: max + 2,
        role: 'assistant',
        content: assistantContent,
        status: suggestion ? 'complete' : 'pending',
        model: suggestion ? null : model,
        createdBy: actor.userId,
      })
      .returning();
    await tx
      .update(agentConversations)
      .set({ updatedAt: new Date() })
      .where(eq(agentConversations.id, conversationId));
    return {
      conversationId,
      userMessageId: user!.id,
      messageId: assistant!.id,
      needsRun: !suggestion,
    };
  });
}

/** Earlier complete turns of a conversation, for the model. Failed and cancelled replies are skipped. */
/** Upper bound on replayed history (JSON characters, ~4 chars/token). */
export const MAX_HISTORY_CHARS = 200_000;

const isDocBlock = (b: unknown) =>
  typeof b === 'object' &&
  b !== null &&
  (b as { type?: string }).type === 'text' &&
  ((b as { text?: string }).text ?? '').startsWith('<document>');

/** Older rows stored the document inside the user turn; history never replays it. */
function withoutDocument(turn: Anthropic.MessageParam): Anthropic.MessageParam {
  if (typeof turn.content === 'string') return turn;
  return { ...turn, content: turn.content.filter((b) => !isDocBlock(b)) } as Anthropic.MessageParam;
}

/**
 * Keep the most recent exchanges within MAX_HISTORY_CHARS. The cut only moves when the window
 * overflows, and then jumps to half the budget, so between jumps the history prefix stays the
 * same from request to request (prompt-cache friendly).
 */
export function windowHistory(
  exchanges: Anthropic.MessageParam[][],
  maxChars = MAX_HISTORY_CHARS,
): Anthropic.MessageParam[] {
  const sizes = exchanges.map((e) => JSON.stringify(e).length);
  // Replays how the window evolves turn by turn, so the result for N exchanges only differs
  // from N-1 at the moment of an overflow.
  let cut = 0;
  let acc = 0;
  for (let i = 0; i < sizes.length; i++) {
    acc += sizes[i]!;
    if (acc > maxChars) while (acc > maxChars / 2 && cut < i) acc -= sizes[cut++]!;
  }
  return exchanges.slice(cut).flat();
}

/** Earlier complete turns of a conversation, for the model. Failed and cancelled replies are skipped. */
async function historyBefore(db: Db, conversationId: string, seq: number) {
  const rows = await db
    .select()
    .from(agentMessages)
    .where(
      and(eq(agentMessages.conversationId, conversationId), sql`${agentMessages.seq} < ${seq}`),
    )
    .orderBy(asc(agentMessages.seq));
  // One exchange = a user message and its (complete) reply; cuts happen between exchanges.
  const exchanges: Anthropic.MessageParam[][] = [];
  for (const r of rows) {
    if (r.role === 'user')
      exchanges.push((r.content as StoredUserContent).turns.map(withoutDocument));
    else if (r.role === 'assistant' && r.status === 'complete' && exchanges.length)
      exchanges.at(-1)!.push(...((r.content as StoredAssistantContent).turns ?? []));
  }
  return windowHistory(exchanges);
}

export interface RunDeps {
  proxy?: LlmProxyDeps;
  /** Min interval between progress writes (ms). */
  flushMs?: number;
  /** How often to check for cancellation while the model is thinking (ms). */
  cancelPollMs?: number;
  /** Hard limit for the turn, below the route's maxDuration (300s). */
  deadlineMs?: number;
  /** Runs before the message's first transaction. Defaults to the auto snapshot (Story 5.12). */
  beforeFirstCommit?: (messageId: string) => Promise<void>;
}

function userFacingError(e: unknown): string {
  if (e instanceof ProviderError) return e.message;
  if (e instanceof LockedError) return 'Another member is editing this project.';
  if (e instanceof ValidationError || e instanceof NotFoundError) return e.message;
  if (e instanceof Error && e.name === 'AgentTurnError') return e.message;
  return 'Something went wrong running the agent.';
}

/** Run a pending assistant message to completion (or error/cancel). Never throws. */
export async function runAssistantMessage(
  db: Db,
  actor: Actor,
  messageId: string,
  deps: RunDeps = {},
): Promise<MessageView> {
  const flushMs = deps.flushMs ?? 250;
  const controller = new AbortController();
  let row = await loadMessage(db, actor, messageId);
  const claimed = await db
    .update(agentMessages)
    .set({ status: 'streaming' })
    .where(and(eq(agentMessages.id, messageId), eq(agentMessages.status, 'pending')))
    .returning({ id: agentMessages.id });
  if (!claimed.length) return toMessageView(row); // already running, finished or cancelled

  let latest: TurnUpdate | null = null;
  let lastUpdate: TurnUpdate | null = null;
  let writing: Promise<void> = Promise.resolve();
  let lastFlush = 0;
  const checkCancelled = async () => {
    const [r] = await db
      .select({ status: agentMessages.status })
      .from(agentMessages)
      .where(eq(agentMessages.id, messageId));
    if (r?.status === 'cancelled') controller.abort();
  };
  const flush = () => {
    const u = latest;
    if (!u) return writing;
    latest = null;
    lastFlush = Date.now();
    writing = writing.then(async () => {
      const content: StoredAssistantContent = {
        v: 1,
        turns: u.turns,
        partial: u.partial,
        activity: u.activity,
      };
      await db
        .update(agentMessages)
        .set({ content })
        .where(and(eq(agentMessages.id, messageId), eq(agentMessages.status, 'streaming')));
      await checkCancelled();
    });
    return writing;
  };
  const poll = setInterval(() => void checkCancelled().catch(() => {}), deps.cancelPollMs ?? 1000);
  // Settle the message ourselves before the platform kills the function at maxDuration.
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deps.deadlineMs ?? TURN_DEADLINE_MS);

  let final: {
    status: 'complete' | 'error' | 'cancelled';
    content: StoredAssistantContent;
    error: string | null;
  };
  try {
    const conv = await loadConversation(db, actor, row.conversationId);
    const project = await getProject(db, actor, conv.projectId);
    const ds = await resolveProjectDesignSystem(db, actor, project);
    const [userRow] = await db
      .select()
      .from(agentMessages)
      .where(and(eq(agentMessages.conversationId, conv.id), eq(agentMessages.seq, row.seq - 1)));
    if (!userRow || userRow.role !== 'user') throw new ValidationError('Missing user message');
    const stored = userRow.content as StoredUserContent;
    const { doc } = await getDoc(db, actor, conv.projectId);
    const base = withoutDocument(stored.turns[0]!);
    const userTurn: Anthropic.MessageParam = {
      role: 'user',
      content: [
        { type: 'text', text: buildTurnContext(doc, stored.context ?? {}) },
        ...(typeof base.content === 'string'
          ? [{ type: 'text' as const, text: base.content }]
          : base.content),
      ],
    };
    const scope = conv.scope as { nodeId: string; allowWider?: boolean } | null;
    const host = await createDbToolHost(db, actor, {
      projectId: conv.projectId,
      agentMessageId: messageId,
      runtime: 'interactive',
      maxOpsPerPatch: 200,
      scope: scope
        ? { rootNodeId: scope.nodeId, allowWider: Boolean(scope.allowWider) }
        : undefined,
      beforeFirstCommit: () =>
        deps.beforeFirstCommit
          ? deps.beforeFirstCommit(messageId)
          : snapshotBeforeAgentEdit(db, actor, conv.projectId, messageId).then(() => undefined),
    });
    const history = await historyBefore(db, conv.id, userRow.seq);
    const ctx = {
      workspaceId: actor.workspace.id,
      userId: actor.userId,
      projectId: conv.projectId,
      conversationId: conv.id,
      messageId,
      task: 'interactive' as const,
    };
    const result = await runAgentTurn({
      gateway: (params, o) => streamModel(db, ctx, params, o, deps.proxy),
      model:
        row.model ?? resolveModel(await getModelSettings(db, actor.workspace.id), 'interactive'),
      prefix: buildPrefix('interactive', ds.spec, prefixCacheTtl()),
      history,
      userTurn,
      host,
      signal: controller.signal,
      effort: 'medium',
      onUpdate: (u) => {
        latest = u;
        lastUpdate = u;
        if (Date.now() - lastFlush >= flushMs) void flush();
      },
    });
    final = {
      status: timedOut ? 'error' : controller.signal.aborted ? 'cancelled' : 'complete',
      content: {
        v: 1,
        turns: result.turns,
        activity: [],
        touched: result.touched,
        jobSuggestion: result.jobSuggestion,
        stopReason: result.stopReason,
      },
      error: timedOut
        ? TIMEOUT_ERROR
        : result.stopReason === 'refusal'
          ? 'The model declined this request.'
          : result.stopReason === 'max_iterations'
            ? 'Stopped after too many steps.'
            : null,
    };
  } catch (e) {
    const aborted = controller.signal.aborted && !timedOut;
    if (!aborted) console.error('[agent] turn failed', e instanceof Error ? e.name : typeof e);
    const u = lastUpdate as TurnUpdate | null;
    final = {
      status: aborted ? 'cancelled' : 'error',
      content: {
        v: 1,
        turns: u?.turns ?? [],
        partial: u?.partial ?? null,
        activity: u?.activity ?? [],
      },
      error: aborted ? null : timedOut ? TIMEOUT_ERROR : userFacingError(e),
    };
  } finally {
    clearInterval(poll);
    clearTimeout(deadline);
  }
  await writing.catch(() => {});
  // A user cancel wins over completion; otherwise write the final state.
  const [updated] = await db
    .update(agentMessages)
    .set({ status: final.status, content: final.content, error: final.error })
    .where(and(eq(agentMessages.id, messageId), inArray(agentMessages.status, ['streaming'])))
    .returning();
  if (!updated) {
    // Cancelled while finishing: keep the cancel, but store what was produced.
    await db
      .update(agentMessages)
      .set({ content: final.content })
      .where(eq(agentMessages.id, messageId));
  }
  row = await loadMessage(db, actor, messageId);
  return toMessageView(row);
}

export async function cancelMessage(db: Db, actor: Actor, messageId: string): Promise<MessageView> {
  assertCan(actor.role, 'agent:run');
  await loadMessage(db, actor, messageId);
  await db
    .update(agentMessages)
    .set({ status: 'cancelled' })
    .where(
      and(eq(agentMessages.id, messageId), inArray(agentMessages.status, ['pending', 'streaming'])),
    );
  return toMessageView(await loadMessage(db, actor, messageId));
}

export async function getMessageView(
  db: Db,
  actor: Actor,
  messageId: string,
): Promise<MessageView> {
  assertCan(actor.role, 'project:read');
  return toMessageView(await loadMessage(db, actor, messageId));
}

export const messageStreamUrl = (messageId: string) => `/api/agent/messages/${messageId}/stream`;

/**
 * SSE frames for one message: a `message` event whenever its state changes, then `done` when it
 * reaches a terminal status. Ends after `maxMs` so serverless functions recycle; EventSource
 * reconnects and gets the current state immediately.
 */
export async function* messageEvents(
  db: Db,
  actor: Actor,
  messageId: string,
  opts: { signal?: AbortSignal; pollMs?: number; maxMs?: number; keepaliveMs?: number } = {},
): AsyncGenerator<string> {
  assertCan(actor.role, 'project:read');
  await loadMessage(db, actor, messageId);
  const pollMs = opts.pollMs ?? 300;
  const deadline = Date.now() + (opts.maxMs ?? 240_000);
  const keepaliveMs = opts.keepaliveMs ?? 15_000;
  let last = '';
  let lastSent = Date.now();
  let n = 0;
  yield encodeSse({ retry: 1000, data: { messageId }, event: 'open' });
  while (!opts.signal?.aborted) {
    let row = await loadMessage(db, actor, messageId);
    if (!TERMINAL.has(row.status) && (await settleStaleMessages(db, { messageId })))
      row = await loadMessage(db, actor, messageId);
    const view = toMessageView(row);
    const json = JSON.stringify(view);
    if (json !== last) {
      last = json;
      lastSent = Date.now();
      yield encodeSse({ event: 'message', id: ++n, data: view });
    }
    if (TERMINAL.has(view.status)) {
      yield encodeSse({ event: 'done', data: { status: view.status } });
      return;
    }
    if (Date.now() > deadline) return;
    if (Date.now() - lastSent > keepaliveMs) {
      lastSent = Date.now();
      yield SSE_KEEPALIVE;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
