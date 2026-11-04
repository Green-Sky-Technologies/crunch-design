import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Anthropic, parseSse } from '@crunch/agent';
import { eq, jobs, jobTokens, llmCalls, workspaceAgentSettings, type Db } from '@crunch/db';
import { createProject } from '@/server/services/projects';
import {
  issueJobToken,
  revokeJobTokens,
  verifyJobToken,
  JobTokenError,
  hashJobToken,
} from '@/server/services/agent/job-tokens';
import {
  handleCountTokensProxy,
  handleMessagesProxy,
  streamModel,
  type BudgetHook,
  type LlmProxyDeps,
} from '@/server/services/llm-proxy';
import { makeActor, reset, testDb } from './helpers';
import { scriptedClient, textBlock, type ScriptedResponse } from './fakes/anthropic';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

async function setupJob(database: Db = db) {
  const editor = await makeActor(database, 'editor');
  const project = await createProject(database, editor, { name: 'P' });
  const [job] = await database
    .insert(jobs)
    .values({
      workspaceId: editor.workspace.id,
      projectId: project.id,
      kind: 'generate',
      status: 'running',
      input: { prompt: 'x', frameCount: 1 },
      createdBy: editor.userId,
    })
    .returning();
  const { token } = await issueJobToken(database, job!.id, 600);
  return { editor, project, job: job!, token };
}

function deps(script: ScriptedResponse[], extra: Partial<LlmProxyDeps> = {}) {
  const client = scriptedClient(script);
  const d: LlmProxyDeps = {
    loadClient: async () => ({ messages: client.messages, provider: 'anthropic' }),
    ...extra,
  };
  return { client, deps: d };
}

const request = (token: string | null, body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/llm/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });

const msgBody = (extra: Record<string, unknown> = {}) => ({
  model: 'claude-sonnet-5-5',
  max_tokens: 1000,
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});

describe('job tokens', () => {
  it('stores only a hash and resolves to the job', async () => {
    const { job, token } = await setupJob();
    const rows = await db.select().from(jobTokens).where(eq(jobTokens.jobId, job.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashJobToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect((await verifyJobToken(db, token)).id).toBe(job.id);
  });

  it('rejects revoked, expired, unknown and malformed tokens, and terminal jobs', async () => {
    const { job, token } = await setupJob();
    await expect(verifyJobToken(db, 'nope')).rejects.toBeInstanceOf(JobTokenError);
    await expect(verifyJobToken(db, 'cjt_unknown')).rejects.toThrow(/Unknown/);
    await expect(verifyJobToken(db, token, new Date(Date.now() + 601_000))).rejects.toThrow(
      /expired/,
    );
    await db.update(jobs).set({ status: 'succeeded' }).where(eq(jobs.id, job.id));
    await expect(verifyJobToken(db, token)).rejects.toThrow(/no longer running/);
    await db.update(jobs).set({ status: 'running' }).where(eq(jobs.id, job.id));
    await revokeJobTokens(db, job.id);
    await expect(verifyJobToken(db, token)).rejects.toThrow(/revoked/);
  });
});

describe('LLM proxy (HTTP, for sandboxes)', () => {
  it('forwards a non-streaming call and meters it in llm_calls', async () => {
    const { job, token, editor } = await setupJob();
    const { client, deps: d } = deps([
      {
        content: [textBlock('hello')],
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 2000,
          cache_creation_input_tokens: 100,
          cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 },
        },
      },
    ]);
    const res = await handleMessagesProxy(db, request(token, msgBody()), d);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Anthropic.Message;
    expect(json.content).toEqual([textBlock('hello')]);
    expect(client.calls[0]!.model).toBe('claude-sonnet-5-5');

    const [row] = await db.select().from(llmCalls).where(eq(llmCalls.jobId, job.id));
    expect(row).toMatchObject({
      workspaceId: editor.workspace.id,
      userId: editor.userId,
      task: 'generation',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 2000,
      cacheWriteTokens: 100,
      ok: true,
      stopReason: 'end_turn',
    });
    // 1000*$2 + 500*$10 + 2000*$0.20 + 100*$2*2 (1h write) per MTok = 7800 micro-dollars.
    expect(row!.estCostMicros).toBe(7800);
    expect(row!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('streams SSE events in the Anthropic shape and maps model ids per provider', async () => {
    const { token } = await setupJob();
    const client = scriptedClient([{ content: [textBlock('streamed text here')] }]);
    const res = await handleMessagesProxy(
      db,
      request(token, msgBody({ stream: true }), {
        'anthropic-beta': 'some-beta-2026-01-01',
        'x-api-key': 'ignored-because-bearer-wins',
      }),
      {
        loadClient: async () => ({ messages: client.messages, provider: 'bedrock' }),
      },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = parseSse(await res.text());
    expect(events[0]!.event).toBe('message_start');
    expect(events.at(-1)!.event).toBe('message_stop');
    const text = events
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => JSON.parse(e.data).delta.text)
      .join('');
    expect(text).toBe('streamed text here');
    expect(client.calls[0]!.model).toBe('anthropic.claude-sonnet-5-5');
    expect(client.headers[0]).toEqual({ 'anthropic-beta': 'some-beta-2026-01-01' });
    const rows = await db.select().from(llmCalls);
    expect(rows).toHaveLength(1);
  });

  it('accepts the token via x-api-key too', async () => {
    const { token } = await setupJob();
    const { deps: d } = deps([{ content: [textBlock('ok')] }]);
    const res = await handleMessagesProxy(db, request(null, msgBody(), { 'x-api-key': token }), d);
    expect(res.status).toBe(200);
  });

  it('rejects a revoked job token immediately, without calling the provider', async () => {
    const { job, token } = await setupJob();
    const { client, deps: d } = deps([{ content: [textBlock('ok')] }]);
    expect((await handleMessagesProxy(db, request(token, msgBody()), d)).status).toBe(200);
    await revokeJobTokens(db, job.id);
    const res = await handleMessagesProxy(db, request(token, msgBody()), d);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      type: 'error',
      error: { type: 'authentication_error' },
    });
    expect(client.calls).toHaveLength(1);
    expect((await handleMessagesProxy(db, request(null, msgBody()), d)).status).toBe(401);
  });

  it('enforces the workspace allowed-model list and validates the body', async () => {
    const { token, editor } = await setupJob();
    await db.insert(workspaceAgentSettings).values({
      workspaceId: editor.workspace.id,
      allowedModels: ['claude-haiku-5-5'],
    });
    const { client, deps: d } = deps([{ content: [textBlock('ok')] }]);
    const denied = await handleMessagesProxy(db, request(token, msgBody()), d);
    expect(denied.status).toBe(400);
    expect(((await denied.json()) as { error: { message: string } }).error.message).toMatch(
      /isn't allowed/,
    );
    const unknown = await handleMessagesProxy(db, request(token, msgBody({ model: 'gpt-5' })), d);
    expect(unknown.status).toBe(400);
    const bad = await handleMessagesProxy(db, request(token, { model: 'x' }), d);
    expect(bad.status).toBe(400);
    const ok = await handleMessagesProxy(
      db,
      request(token, msgBody({ model: 'claude-haiku-5-5' })),
      d,
    );
    expect(ok.status).toBe(200);
    expect(client.calls).toHaveLength(1);
  });

  it('calls the budget hook before spending; a denial costs nothing', async () => {
    const { token, editor, job } = await setupJob();
    const check = vi.fn<BudgetHook['check']>(async () => ({ allowed: false, reason: 'cap' }));
    const { client, deps: d } = deps([{ content: [textBlock('ok')] }], { budget: { check } });
    const res = await handleMessagesProxy(db, request(token, msgBody()), d);
    expect(res.status).toBe(429);
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: editor.workspace.id,
        jobId: job.id,
        model: 'claude-sonnet-5-5',
        task: 'generation',
      }),
    );
    expect(client.calls).toHaveLength(0);
    expect(await db.select().from(llmCalls)).toHaveLength(0);
  });

  it('records failed calls and returns the provider status without echoing details', async () => {
    const { token } = await setupJob();
    const err = new Anthropic.RateLimitError(
      429,
      {
        type: 'error',
        error: { type: 'rate_limit_error', message: 'slow down for org-secret-123' },
      },
      'slow down for org-secret-123',
      new Headers(),
    );
    const { deps: d } = deps([{ content: [], error: err }]);
    const res = await handleMessagesProxy(db, request(token, msgBody({ stream: true })), d);
    expect(res.status).toBe(429);
    expect(await res.text()).not.toContain('org-secret-123');
    const [row] = await db.select().from(llmCalls);
    expect(row).toMatchObject({ ok: false, errorType: 'rate_limit_error' });
  });

  it('proxies count_tokens without metering', async () => {
    const { token } = await setupJob();
    const { deps: d } = deps([]);
    const res = await handleCountTokensProxy(
      db,
      new Request('http://localhost/api/llm/v1/messages/count_tokens', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: 'claude-opus-5-5', messages: [] }),
      }),
      d,
    );
    expect(await res.json()).toEqual({ input_tokens: 42 });
    expect(await db.select().from(llmCalls)).toHaveLength(0);
  });

  it('fails cleanly when the workspace has no credential', async () => {
    const { token } = await setupJob();
    const res = await handleMessagesProxy(db, request(token, msgBody()));
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/No model credential/);
  });
});

describe('streamModel (in-process, interactive path)', () => {
  it('forwards events and attributes usage to the conversation and message', async () => {
    const { editor, project } = await setupJob();
    const { deps: d } = deps([{ content: [textBlock('done')] }]);
    const seen: string[] = [];
    const conversationId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const final = await streamModel(
      db,
      {
        workspaceId: editor.workspace.id,
        userId: editor.userId,
        projectId: project.id,
        conversationId,
        messageId,
        task: 'interactive',
      },
      { model: 'claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'x' }] },
      { onEvent: (e) => void seen.push(e.type) },
      d,
    );
    expect(final.content).toEqual([textBlock('done')]);
    expect(seen[0]).toBe('message_start');
    const [row] = await db.select().from(llmCalls);
    expect(row).toMatchObject({ task: 'interactive', conversationId, messageId, jobId: null });
  });
});
