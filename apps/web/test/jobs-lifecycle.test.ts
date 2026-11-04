/** Regression tests for job lifecycle bugs found in review (reaper, heartbeats, retries, ordering). */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseSse } from '@crunch/agent';
import type { JobRunner, StartJob } from '@crunch/contracts';
import { agentConversations, agentMessages, eq, jobEvents, jobs } from '@crunch/db';
import { MemoryJobRunner } from '@crunch/sandbox-runner';
import { createProject } from '@/server/services/projects';
import { upsertMember } from '@/server/services/workspaces';
import { issueJobToken } from '@/server/services/agent/job-tokens';
import { handleJobMcp } from '@/server/services/agent/job-mcp';
import { handleMessagesProxy } from '@/server/services/llm-proxy';
import {
  cancelJob,
  createJob,
  jobEventFrames,
  PROVISION_TIMEOUT_MS,
  reapJobs,
  reportJobEvent,
  startJob,
} from '@/server/services/jobs';
import { ValidationError } from '@/server/services/types';
import { makeActor, reset, testDb } from './helpers';
import { scriptedClient, textBlock } from './fakes/anthropic';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

async function setup() {
  const editor = await makeActor(db, 'editor');
  await upsertMember(db, editor.workspace.id, editor.userId, 'editor');
  const project = await createProject(db, editor, { name: 'P' });
  const [conv] = await db
    .insert(agentConversations)
    .values({ workspaceId: editor.workspace.id, projectId: project.id, createdBy: editor.userId })
    .returning();
  const [msg] = await db
    .insert(agentMessages)
    .values({
      conversationId: conv!.id,
      workspaceId: editor.workspace.id,
      seq: 1,
      role: 'assistant',
      content: { v: 1, turns: [] },
      status: 'streaming',
    })
    .returning();
  const job = await createJob(db, editor, {
    kind: 'generate',
    input: { prompt: 'x', frameCount: 1 },
    projectId: project.id,
    conversationId: conv!.id,
    messageId: msg!.id,
  });
  return { editor, project, job, messageId: msg!.id };
}

const row = async (id: string) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
const minutes = (n: number) => () => new Date(Date.now() + n * 60_000);

describe('reaper vs provisioning (review #1)', () => {
  it('leaves a job alone while its sandbox is still being provisioned', async () => {
    const { job } = await setup();
    let release!: (v: { sandboxId: string }) => void;
    const slow: JobRunner = {
      start: (_j: StartJob) => new Promise((r) => (release = r)),
      cancel: async () => {},
      isAlive: async () => true,
    };
    const starting = startJob(db, job.id, { runner: slow });
    await new Promise((r) => setTimeout(r, 20));
    expect((await row(job.id)).status).toBe('provisioning');
    const res = await reapJobs(db, { runner: slow, now: minutes(2) });
    expect(res).toMatchObject({ retried: [], orphaned: [], timedOut: [] });
    release({ sandboxId: 'sbx-slow' });
    expect((await starting)?.status).toBe('running');
    expect((await row(job.id)).attempts).toBe(1);
  });

  it('retries provisioning that never finished, after the provisioning deadline', async () => {
    const { job } = await setup();
    await db
      .update(jobs)
      .set({ status: 'provisioning', attempts: 1, heartbeatAt: new Date() })
      .where(eq(jobs.id, job.id));
    const runner = new MemoryJobRunner();
    const res = await reapJobs(db, {
      runner,
      now: () => new Date(Date.now() + PROVISION_TIMEOUT_MS + 60_000),
    });
    expect(res.retried).toEqual([job.id]);
  });
});

describe('heartbeats and retries (review #2)', () => {
  async function staleRunning() {
    const s = await setup();
    const runner = new MemoryJobRunner();
    await startJob(db, s.job.id, { runner });
    const { token } = await issueJobToken(db, s.job.id, 3600);
    await db
      .update(jobs)
      .set({ heartbeatAt: new Date(Date.now() - 6 * 60_000) })
      .where(eq(jobs.id, s.job.id));
    return { ...s, runner, token };
  }

  it('model calls through the proxy keep a long-running job alive', async () => {
    const { job, runner, token } = await staleRunning();
    const client = scriptedClient([{ content: [textBlock('still working')] }]);
    const res = await handleMessagesProxy(
      db,
      new Request('http://x/api/llm/v1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          model: 'claude-opus-5-5',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'x' }],
          stream: true,
        }),
      }),
      { loadClient: async () => ({ messages: client.messages, provider: 'anthropic' }) },
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    expect(Date.now() - (await row(job.id)).heartbeatAt!.getTime()).toBeLessThan(10_000);
    const reaped = await reapJobs(db, { runner });
    expect(reaped.retried).toEqual([]);
    expect((await row(job.id)).status).toBe('running');
  });

  it('MCP tool calls refresh the heartbeat', async () => {
    const { job, token } = await staleRunning();
    await handleJobMcp(
      db,
      new Request('http://x/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'get_outline', arguments: {} },
        }),
      }),
      job.id,
    );
    expect(Date.now() - (await row(job.id)).heartbeatAt!.getTime()).toBeLessThan(10_000);
  });

  it('does not re-run a lost job that already committed edits', async () => {
    const { job, runner, messageId } = await staleRunning();
    await db
      .update(agentMessages)
      .set({ txnIds: ['agent-txn-1'] })
      .where(eq(agentMessages.id, messageId));
    runner.alive.set('mem-sbx-1', false);
    const res = await reapJobs(db, { runner });
    expect(res.retried).toEqual([]);
    expect(res.orphaned).toEqual([job.id]);
    const r = await row(job.id);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/not retried/);
    expect(runner.started).toHaveLength(1);
  });
});

describe('event ordering and status ownership (review #3, #14)', () => {
  it('rejects sandbox-originated status events', async () => {
    const { job } = await setup();
    await startJob(db, job.id, { runner: new MemoryJobRunner() });
    const { token } = await issueJobToken(db, job.id, 600);
    await expect(
      reportJobEvent(db, token, job.id, { type: 'status', data: { phase: 'agent_started' } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await reportJobEvent(db, token, job.id, { type: 'progress', data: { phase: 'agent_started' } });
  });

  it('writes the result before the terminal status, and the stream ends after both', async () => {
    const { job, editor } = await setup();
    await startJob(db, job.id, { runner: new MemoryJobRunner() });
    const { token } = await issueJobToken(db, job.id, 600);
    await reportJobEvent(db, token, job.id, { type: 'result', data: { summary: 'ok' } });
    const events = (await db.select().from(jobEvents).where(eq(jobEvents.jobId, job.id))).sort(
      (a, b) => a.seq - b.seq,
    );
    expect(events.slice(-2).map((e) => e.type)).toEqual(['result', 'status']);
    expect((await row(job.id)).lastEventSeq).toBe(events.at(-1)!.seq);
    let text = '';
    for await (const f of jobEventFrames(db, editor, job.id, 0, { pollMs: 5 })) text += f;
    const types = parseSse(text).map((e) => e.event);
    expect(types.slice(-3)).toEqual(['result', 'status', 'done']);
  });

  it('drops a result that arrives after a cancel', async () => {
    const { job, editor } = await setup();
    const runner = new MemoryJobRunner();
    await startJob(db, job.id, { runner });
    const { token } = await issueJobToken(db, job.id, 600);
    await cancelJob(db, editor, job.id, { runner });
    await expect(
      reportJobEvent(db, token, job.id, { type: 'result', data: { summary: 'late' } }),
    ).rejects.toThrow();
    const events = await db.select().from(jobEvents).where(eq(jobEvents.jobId, job.id));
    expect(events.some((e) => e.type === 'result')).toBe(false);
    expect((await row(job.id)).status).toBe('cancelled');
  });
});
