/** Proxy hardening (review #5, #10) and the real BYOK injection path (review test gap). */
import { generateMasterKey } from '@crunch/crypto';
// The env keyring is read lazily on first use; set it before anything decrypts.
process.env.CREDENTIALS_MASTER_KEYS = `t1:${generateMasterKey()}`;

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeSse, type Anthropic } from '@crunch/agent';
import { jobs, llmCalls } from '@crunch/db';
import { saveCredential } from '@/server/services/credentials';
import { createProject } from '@/server/services/projects';
import { issueJobToken } from '@/server/services/agent/job-tokens';
import {
  filterBetas,
  handleMessagesProxy,
  type LlmProxyDeps,
  type MessagesApi,
} from '@/server/services/llm-proxy';
import { makeActor, reset, testDb } from './helpers';
import { eventsFor, scriptedClient, textBlock } from './fakes/anthropic';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));
afterEach(() => vi.unstubAllGlobals());

async function setupJob() {
  const admin = await makeActor(db, 'admin');
  const project = await createProject(db, admin, { name: 'P' });
  const [job] = await db
    .insert(jobs)
    .values({
      workspaceId: admin.workspace.id,
      projectId: project.id,
      kind: 'generate',
      status: 'running',
      input: { prompt: 'x', frameCount: 1 },
      createdBy: admin.userId,
    })
    .returning();
  const { token } = await issueJobToken(db, job!.id, 600);
  return { admin, job: job!, token };
}

const post = (token: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/llm/v1/messages', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body),
  });

const base = {
  model: 'claude-sonnet-5-5',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'hi' }],
};

describe('request allowlist', () => {
  it.each([
    ['mcp_servers', { mcp_servers: [{ type: 'url', url: 'https://evil.example/mcp', name: 'x' }] }],
    ['container', { container: { skills: [] } }],
    ['speed', { speed: 'fast' }],
    ['service_tier', { service_tier: 'auto' }],
    ['server tool', { tools: [{ type: 'web_search_20260209', name: 'web_search' }] }],
    ['code execution', { tools: [{ type: 'code_execution_20260521', name: 'code_execution' }] }],
    ['MCP toolset', { tools: [{ type: 'mcp_toolset', mcp_server_name: 'x' }] }],
    ['unknown field', { surprise: true }],
  ])('rejects %s without calling the provider', async (_label, extra) => {
    const { token } = await setupJob();
    const client = scriptedClient([{ content: [textBlock('x')] }]);
    const res = await handleMessagesProxy(db, post(token, { ...base, ...extra }), {
      loadClient: async () => ({ messages: client.messages, provider: 'anthropic' }),
    });
    expect(res.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });

  it('accepts what the Agent SDK sends: system, custom tools, thinking, cache control', async () => {
    const { token } = await setupJob();
    const client = scriptedClient([{ content: [textBlock('ok')] }]);
    const res = await handleMessagesProxy(
      db,
      post(token, {
        ...base,
        system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
        tools: [
          { name: 'mcp__crunch__get_outline', description: 'd', input_schema: { type: 'object' } },
        ],
        tool_choice: { type: 'auto' },
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        metadata: { user_id: 'u' },
        stream: true,
      }),
      { loadClient: async () => ({ messages: client.messages, provider: 'anthropic' }) },
    );
    expect(res.status).toBe(200);
    await res.text();
    expect(client.calls).toHaveLength(1);
  });
});

describe('beta allowlist', () => {
  it('rejects betas that enable server tools, MCP egress, fast mode or fallbacks', async () => {
    const { token } = await setupJob();
    const client = scriptedClient([{ content: [textBlock('x')] }]);
    const deps: LlmProxyDeps = {
      loadClient: async () => ({ messages: client.messages, provider: 'anthropic' }),
    };
    for (const beta of [
      'mcp-client-2025-11-20',
      'fast-mode-2026-02-01',
      'code-execution-2025-08-25',
      'server-side-fallback-2026-07-01',
    ]) {
      const res = await handleMessagesProxy(
        db,
        post(token, base, { 'anthropic-beta': `interleaved-thinking-2025-05-14,${beta}` }),
        deps,
      );
      expect(res.status).toBe(400);
    }
    expect(client.calls).toHaveLength(0);
  });

  it('forwards every non-forbidden beta Claude Code sends (regression: jobs 400ed)', async () => {
    // Captured from Agent SDK 0.3.318. It pairs `thinking.display: "updates"` with the
    // thinking-display-updates beta; dropping that beta made every job request fail with a 400.
    const claudeCodeBetas =
      'claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,thinking-token-count-2026-05-13,effort-2025-11-24,thinking-display-updates-2026-08-18';
    const { token } = await setupJob();
    const client = scriptedClient([{ content: [textBlock('x')] }]);
    const res = await handleMessagesProxy(
      db,
      post(
        token,
        { ...base, thinking: { type: 'adaptive', display: 'updates' } },
        { 'anthropic-beta': claudeCodeBetas },
      ),
      { loadClient: async () => ({ messages: client.messages, provider: 'anthropic' }) },
    );
    expect(res.status).toBe(200);
    expect(client.headers[0]).toEqual({ 'anthropic-beta': claudeCodeBetas });
    expect(filterBetas('some-new-beta-2026-12-01, some-new-beta-2026-12-01')).toBe(
      'some-new-beta-2026-12-01',
    );
  });

  it('still rejects dangerous or malformed betas', () => {
    for (const b of [
      'mcp-client-2025-11-20',
      'fast-mode-2026-02-01',
      'code-execution-2025-08-25',
      'files-api-2025-04-14',
      'web-search-x',
      'container-x',
      'advisor-tool-x',
    ]) {
      expect(() => filterBetas(`interleaved-thinking-2025-05-14,${b}`), b).toThrow(/not allowed/);
    }
    expect(() => filterBetas('bad beta;')).toThrow(/Malformed/);
  });
});

describe('metering of streams that end early', () => {
  it('records the last usage and an output estimate, marked incomplete', async () => {
    const { token, job } = await setupJob();
    const events = eventsFor('claude-sonnet-5-5', { content: [textBlock('x'.repeat(400))] });
    const cut: MessagesApi = {
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          for (const e of events.filter(
            (e) => e.type !== 'message_delta' && e.type !== 'message_stop',
          ))
            yield e;
          const err = new Error('socket closed');
          err.name = 'AbortError';
          throw err;
        },
        finalMessage: () => Promise.reject(new Error('no final')),
      }),
      countTokens: async () => ({ input_tokens: 0 }) as Anthropic.MessageTokensCount,
    };
    const res = await handleMessagesProxy(db, post(token, { ...base, stream: true }), {
      loadClient: async () => ({ messages: cut, provider: 'bedrock' }),
    });
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    const [row] = await db.select().from(llmCalls);
    expect(row).toMatchObject({
      ok: false,
      stopReason: 'incomplete',
      inputTokens: 100,
      jobId: job.id,
    });
    expect(row!.outputTokens).toBeGreaterThanOrEqual(100); // 400 chars ≈ 100 tokens
    expect(row!.estCostMicros).toBeGreaterThan(0);
  });
});

describe('BYOK through the real client path (no fakes for credentials)', () => {
  it('injects the workspace key server-side and never forwards the sandbox token upstream', async () => {
    const { admin, token } = await setupJob();
    const realKey = 'sk-ant-api03-' + 'B'.repeat(40) + 'YOKK';
    await saveCredential(db, admin, { provider: 'anthropic', apiKey: realKey });
    const upstream: { url: string; headers: Headers; body: string }[] = [];
    const sse = eventsFor('claude-sonnet-5-5', { content: [textBlock('hello from upstream')] })
      .map((e) => encodeSse({ event: e.type, data: e }))
      .join('');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const req = new Request(url, init);
        upstream.push({ url: req.url, headers: req.headers, body: await req.text() });
        return new Response(sse, {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test' },
        });
      }),
    );
    const res = await handleMessagesProxy(
      db,
      post(token, { ...base, stream: true }, { 'x-api-key': 'sandbox-should-not-forward' }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('hello fr'); // text arrives in streamed deltas
    expect(body).toContain('message_stop');
    expect(body).not.toContain(realKey);

    expect(upstream).toHaveLength(1);
    const call = upstream[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    // The SDK sends the API key as a bearer token (or x-api-key); either way it's the workspace key.
    const sent =
      call.headers.get('x-api-key') ?? call.headers.get('authorization')?.replace(/^Bearer /, '');
    expect(sent).toBe(realKey);
    expect(JSON.stringify([...call.headers.entries()])).not.toContain(token);
    expect(JSON.stringify([...call.headers.entries()])).not.toContain('sandbox-should-not-forward');
    expect(call.body).not.toContain(token);
    const [row] = await db.select().from(llmCalls);
    expect(row).toMatchObject({ ok: true, provider: 'anthropic' });
  });
});
