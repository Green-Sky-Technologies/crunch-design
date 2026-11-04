import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { agentMessages, eq, jobs } from '@crunch/db';
import { MemoryJobRunner } from '@crunch/sandbox-runner';
import { getDoc } from '@/server/services/design-docs';
import { createProject } from '@/server/services/projects';
import { upsertMember } from '@/server/services/workspaces';
import { issueJobToken } from '@/server/services/agent/job-tokens';
import { handleJobMcp } from '@/server/services/agent/job-mcp';
import { startGenerationJob } from '@/server/services/agent/generation';
import { prepareJob } from '@/server/services/agent/runner';
import { getJob, reportJobEvent, startJob } from '@/server/services/jobs';
import { getProjectChat } from '@/server/services/agent';
import { ValidationError } from '@/server/services/types';
import { makeActor, reset, testDb } from './helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

async function setup() {
  const editor = await makeActor(db, 'editor');
  await upsertMember(db, editor.workspace.id, editor.userId, 'editor');
  const project = await createProject(db, editor, { name: 'P' });
  const { doc } = await getDoc(db, editor, project.id);
  return { editor, project, frame: doc.frames[0]! };
}

const frameArgs = (n: number, name: string) => ({
  frame: { id: `f_alt00000${n}`, name, rootNodeId: `n_altroot00${n}`, width: 1280, height: 'auto' },
  nodes: [
    {
      id: `n_altroot00${n}`,
      type: 'box',
      tag: 'main',
      parentId: null,
      children: [],
      positioning: 'flow',
      style: {},
      props: {},
    },
  ],
});

async function mcpCall(token: string, jobId: string, name: string, args: unknown) {
  const res = await handleJobMcp(
    db,
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
    jobId,
  );
  return (await res.json()).result;
}

describe('generation jobs', () => {
  it('alternatives land as sibling frames and the summary lists what was created', async () => {
    const { editor, project, frame } = await setup();
    const { job, message } = await startGenerationJob(db, editor, {
      projectId: project.id,
      kind: 'alternatives',
      prompt: 'bolder',
      frameIds: [frame.id],
      count: 2,
    });
    expect(job.input).toMatchObject({ frameId: frame.id, count: 2 });
    expect(message).toMatchObject({ status: 'streaming', jobId: job.id, model: 'claude-opus-5-5' });

    const prepared = await prepareJob(db, {
      jobId: job.id,
      workspaceId: editor.workspace.id,
      kind: job.kind,
      input: job.input,
      timeoutSeconds: job.timeoutSeconds,
    });
    expect(prepared.model).toBe('claude-opus-5-5');
    expect(prepared.spec.prompt).toContain('2 alternative designs');
    expect(prepared.spec.prompt).toContain(`frame ${frame.id}`);
    expect(prepared.spec.systemPrompt).toContain('<design_system>');
    expect(prepared.spec.tools).toContain('insert_frame');

    await startJob(db, job.id, { runner: new MemoryJobRunner() });
    const { token } = await issueJobToken(db, job.id, 600);
    for (const n of [1, 2]) {
      const r = await mcpCall(token, job.id, 'insert_frame', frameArgs(n, `Desktop — Alt ${n}`));
      expect(r.isError).toBe(false);
    }
    const { doc } = await getDoc(db, editor, project.id);
    expect(doc.frames.map((f) => f.name)).toEqual([
      'Desktop',
      'Desktop — Alt 1',
      'Desktop — Alt 2',
    ]);
    const xs = doc.frames.map((f) => f.canvas.x);
    expect(new Set(xs).size).toBe(3); // side by side, not stacked
    expect(doc.frames.every((f) => f.canvas.y === 0)).toBe(true);

    await reportJobEvent(db, token, job.id, { type: 'result', data: { summary: 'Two takes.' } });
    const view = await getJob(db, editor, job.id);
    expect(view.status).toBe('succeeded');
    expect((view.result as { frames: unknown[] }).frames).toHaveLength(2);
    const chat = await getProjectChat(db, editor, project.id);
    const msg = chat.messages.find((m) => m.jobId === job.id)!;
    expect(msg.status).toBe('complete');
    expect(msg.text).toContain('Created 2 frames: Desktop — Alt 1, Desktop — Alt 2');
  });

  it('builds kind-specific inputs and rejects empty requests', async () => {
    const { editor, project, frame } = await setup();
    const gen = await startGenerationJob(db, editor, {
      projectId: project.id,
      kind: 'generate',
      prompt: 'Pricing page',
    });
    expect(gen.job.input).toEqual({ prompt: 'Pricing page', frameCount: 1 });
    const re = await startGenerationJob(db, editor, {
      projectId: project.id,
      conversationId: gen.message.conversationId,
      kind: 'redesign',
      prompt: 'Make it dark',
    });
    expect(re.job.input).toEqual({ prompt: 'Make it dark', frameIds: [frame.id] });
    expect(re.message.conversationId).toBe(gen.message.conversationId);
    await expect(
      startGenerationJob(db, editor, { projectId: project.id, kind: 'generate', prompt: '' }),
    ).rejects.toBeInstanceOf(ValidationError);
    const rows = await db.select().from(jobs);
    expect(rows).toHaveLength(2);
    const msgs = await db.select().from(agentMessages).where(eq(agentMessages.jobId, re.job.id));
    expect(msgs).toHaveLength(1);
  });
});
