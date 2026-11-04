import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@crunch/authz';
import { generateMasterKey, parseKeyring } from '@crunch/crypto';
import { parseSse } from '@crunch/agent';
import { agentConversations, agentMessages, docOps, eq, jobEvents, jobs } from '@crunch/db';
import { MemoryJobRunner, recordingSandboxApi } from '@crunch/sandbox-runner';
import { saveCredential } from '@/server/services/credentials';
import { getDoc } from '@/server/services/design-docs';
import { createProject } from '@/server/services/projects';
import { upsertMember } from '@/server/services/workspaces';
import { JobTokenError, verifyJobToken, issueJobToken } from '@/server/services/agent/job-tokens';
import { handleJobMcp } from '@/server/services/agent/job-mcp';
import { jobRunner } from '@/server/services/agent/runner';
import {
  cancelJob,
  createJob,
  jobEventFrames,
  listJobEvents,
  reapJobs,
  reportJobEvent,
  startJob,
} from '@/server/services/jobs';
import { ValidationError, type Actor } from '@/server/services/types';
import { makeActor, reset, testDb } from './helpers';

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
      model: 'claude-opus-5-5',
    })
    .returning();
  return { editor, project, messageId: msg!.id, conversationId: conv!.id };
}

const generate = (projectId: string, messageId?: string) => ({
  kind: 'generate',
  input: { prompt: 'Design a pricing page', frameCount: 1 },
  projectId,
  messageId,
});

async function startedJob(editor: Actor, projectId: string, messageId?: string) {
  const runner = new MemoryJobRunner();
  const job = await createJob(db, editor, generate(projectId, messageId));
  await startJob(db, job.id, { runner });
  const { token } = await issueJobToken(db, job.id, 600);
  return { job, runner, token };
}

const statuses = async (jobId: string) =>
  (await db.select().from(jobEvents).where(eq(jobEvents.jobId, jobId)))
    .sort((a, b) => a.seq - b.seq)
    .filter((e) => e.type === 'status')
    .map((e) => (e.data as { status: string }).status);

describe('job lifecycle', () => {
  it('queued → provisioning → running → succeeded, with ordered events', async () => {
    const { editor, project, messageId } = await setup();
    const { job, runner, token } = await startedJob(editor, project.id, messageId);
    expect(runner.started[0]).toMatchObject({
      jobId: job.id,
      kind: 'generate',
      timeoutSeconds: 1800,
    });
    await reportJobEvent(db, token, job.id, { type: 'log', data: { text: 'Working' } });
    await reportJobEvent(db, token, job.id, { type: 'result', data: { summary: 'Made 1 frame' } });

    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row).toMatchObject({ status: 'succeeded', attempts: 1, sandboxId: 'mem-sbx-1' });
    expect(row!.result).toMatchObject({ summary: 'Made 1 frame' });
    expect(await statuses(job.id)).toEqual(['queued', 'provisioning', 'running', 'succeeded']);
    const events = await listJobEvents(db, editor, job.id);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));

    // The token dies with the job; the chat message is settled.
    await expect(verifyJobToken(db, token)).rejects.toBeInstanceOf(JobTokenError);
    const [msg] = await db.select().from(agentMessages).where(eq(agentMessages.id, messageId));
    expect(msg).toMatchObject({ status: 'complete', jobId: job.id });
  });

  it('validates input and permissions', async () => {
    const { editor, project } = await setup();
    const viewer = await makeActor(db, 'viewer', editor.workspace);
    await expect(createJob(db, viewer, generate(project.id))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      createJob(db, editor, { kind: 'generate', input: { prompt: '' }, projectId: project.id }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(createJob(db, editor, { kind: 'nope', input: {} })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('cancel stops the sandbox and revokes the token immediately', async () => {
    const { editor, project } = await setup();
    const { job, runner, token } = await startedJob(editor, project.id);
    const view = await cancelJob(db, editor, job.id, { runner });
    expect(view.status).toBe('cancelled');
    expect(runner.cancelled).toEqual(['mem-sbx-1']);
    await expect(
      reportJobEvent(db, token, job.id, { type: 'log', data: {} }),
    ).rejects.toBeInstanceOf(JobTokenError);
  });

  it('a token for one job cannot report into another', async () => {
    const { editor, project } = await setup();
    const a = await startedJob(editor, project.id);
    const b = await startedJob(editor, project.id);
    await expect(reportJobEvent(db, a.token, b.job.id, { type: 'log', data: {} })).rejects.toThrow(
      /different job/,
    );
  });
});

describe('retries, timeouts and reaping', () => {
  it('retries a failed start, then fails after max attempts', async () => {
    const { editor, project } = await setup();
    const runner = new MemoryJobRunner();
    const job = await createJob(db, editor, generate(project.id));
    runner.failNextStart = new Error('quota');
    expect((await startJob(db, job.id, { runner }))?.status).toBe('queued');
    runner.failNextStart = new Error('quota');
    const later = () => new Date(Date.now() + 60_000);
    // The reaper picks up the stuck queued job and tries again (attempt 2 of 2) → failed.
    await reapJobs(db, { runner, now: later });
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('fails timed-out jobs and stops their sandbox', async () => {
    const { editor, project } = await setup();
    const { job, runner } = await startedJob(editor, project.id);
    const res = await reapJobs(db, { runner, now: () => new Date(Date.now() + 3600_000) });
    expect(res.timedOut).toEqual([job.id]);
    expect(runner.cancelled).toEqual(['mem-sbx-1']);
    const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row!.error).toMatch(/Timed out/);
  });

  it('requeues orphaned sandboxes once, then gives up', async () => {
    const { editor, project } = await setup();
    const { job, runner } = await startedJob(editor, project.id);
    runner.alive.set('mem-sbx-1', false);
    const r1 = await reapJobs(db, { runner });
    expect(r1.retried).toEqual([job.id]);
    // Next pass restarts it (attempt 2); lose that sandbox too.
    await reapJobs(db, { runner, now: () => new Date(Date.now() + 20_000) });
    runner.alive.set('mem-sbx-2', false);
    const r3 = await reapJobs(db, { runner, now: () => new Date(Date.now() + 40_000) });
    expect(r3.orphaned).toEqual([job.id]);
    expect((await db.select().from(jobs).where(eq(jobs.id, job.id)))[0]!.status).toBe('failed');
  });
});

describe('event stream', () => {
  it('replays events after Last-Event-ID with id = seq, then done', async () => {
    const { editor, project } = await setup();
    const { job, token } = await startedJob(editor, project.id);
    await reportJobEvent(db, token, job.id, { type: 'progress', data: { pct: 50 } });
    await reportJobEvent(db, token, job.id, { type: 'result', data: { summary: 'ok' } });
    let text = '';
    for await (const f of jobEventFrames(db, editor, job.id, 2, { pollMs: 5 })) text += f;
    const events = parseSse(text);
    expect(events[0]!.event).toBe('open');
    const ids = events.filter((e) => e.id).map((e) => Number(e.id));
    expect(ids[0]).toBe(3);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(events.at(-1)).toMatchObject({ event: 'done' });
    expect(events.some((e) => e.event === 'progress')).toBe(true);
  });
});

describe('sandbox credential isolation (Story 5.2 AC)', () => {
  it('never puts the real provider key in the sandbox env or filesystem', async () => {
    const { editor, project, messageId } = await setup();
    const admin = await makeActor(db, 'admin', editor.workspace);
    const realKey = 'sk-ant-api03-' + 'Q'.repeat(40) + 'REAL';
    const keyring = parseKeyring(`t1:${generateMasterKey()}`);
    await saveCredential(db, admin, { provider: 'anthropic', apiKey: realKey }, { keyring });
    process.env.ANTHROPIC_API_KEY = realKey; // even if the host process had it
    try {
      const api = recordingSandboxApi();
      const job = await createJob(db, editor, generate(project.id, messageId));
      await startJob(db, job.id, { runner: jobRunner(db, { api }) });
      const [rec] = [...api.sandboxes.values()];
      const everything = JSON.stringify(rec);
      expect(everything).not.toContain(realKey);
      expect(everything).not.toContain('QQQQQQQQQQ');
      expect(rec!.params.env.ANTHROPIC_BASE_URL).toMatch(/\/api\/llm$/);
      const token = rec!.params.env.ANTHROPIC_AUTH_TOKEN!;
      expect(token).toMatch(/^cjt_/);
      expect((await verifyJobToken(db, token)).id).toBe(job.id);
      expect(Object.keys(rec!.params.env).some((k) => /API_KEY|SECRET|AWS|GOOGLE/.test(k))).toBe(
        false,
      );
      const spec = JSON.parse(rec!.files.find((f) => f.path.endsWith('job.json'))!.content);
      expect(spec).toMatchObject({ jobId: job.id, kind: 'generate' });
      expect(spec.prompt).toContain('Design a pricing page');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe('job MCP tool server', () => {
  const rpc = (token: string, jobId: string, body: unknown) =>
    handleJobMcp(
      db,
      new Request(`http://localhost/api/jobs/${jobId}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      jobId,
    );

  it('speaks MCP and runs tools as agent transactions on the job message', async () => {
    const { editor, project, messageId } = await setup();
    const { job, token } = await startedJob(editor, project.id, messageId);
    const init = await (
      await rpc(token, job.id, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      })
    ).json();
    expect(init.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
    });
    expect(
      (await rpc(token, job.id, { jsonrpc: '2.0', method: 'notifications/initialized' })).status,
    ).toBe(202);
    const list = await (
      await rpc(token, job.id, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    ).json();
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain('insert_frame');

    const call = await (
      await rpc(token, job.id, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'insert_frame',
          arguments: {
            frame: {
              id: 'f_pricing0001',
              name: 'Pricing',
              rootNodeId: 'n_pricingroot',
              width: 1280,
              height: 'auto',
            },
            nodes: [
              {
                id: 'n_pricingroot',
                type: 'box',
                tag: 'main',
                parentId: null,
                children: [],
                positioning: 'flow',
                style: {},
                props: {},
              },
            ],
          },
        },
      })
    ).json();
    expect(call.result.isError).toBe(false);
    const { doc } = await getDoc(db, editor, project.id);
    expect(doc.frames.map((f) => f.id)).toContain('f_pricing0001');
    const [log] = await db.select().from(docOps).where(eq(docOps.projectId, project.id));
    expect(log).toMatchObject({ source: 'agent', agentMessageId: messageId });
    const events = await listJobEvents(db, editor, job.id);
    expect(events.find((e) => e.type === 'frame')?.data).toMatchObject({
      frameId: 'f_pricing0001',
    });

    const bad = await rpc('cjt_nope', job.id, { jsonrpc: '2.0', id: 4, method: 'tools/list' });
    expect(bad.status).toBe(401);
    const unknown = await (
      await rpc(token, job.id, { jsonrpc: '2.0', id: 5, method: 'resources/list' })
    ).json();
    expect(unknown.error.code).toBe(-32601);
  });
});
