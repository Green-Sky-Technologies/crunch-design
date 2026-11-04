/** Deployment-wide Vercel AI Gateway: config, precedence, and the proxy's real gateway path. */
import { generateMasterKey } from '@crunch/crypto';
// The env keyring is read lazily on first use; set it before anything decrypts.
process.env.CREDENTIALS_MASTER_KEYS = `t1:${generateMasterKey()}`;

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeSse } from '@crunch/agent';
import { eq, jobs, llmCalls, providerCredentials } from '@crunch/db';
import { AI_GATEWAY_BASE_URL } from '@crunch/providers';
import { deploymentGatewayConfig } from '@/server/services/ai-gateway';
import {
  hasWorkingCredential,
  loadWorkspaceClient,
  saveCredential,
} from '@/server/services/credentials';
import { issueJobToken } from '@/server/services/agent/job-tokens';
import { handleCountTokensProxy, handleMessagesProxy } from '@/server/services/llm-proxy';
import { createProject } from '@/server/services/projects';
import { NotFoundError } from '@/server/services/types';
import { makeActor, reset, testDb } from './helpers';
import { eventsFor, textBlock } from './fakes/anthropic';

const OIDC_TOKEN = 'oidc.' + 'o'.repeat(40) + '.sig';
vi.mock('@vercel/oidc', () => ({ getVercelOidcToken: vi.fn(async () => OIDC_TOKEN) }));

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const GATEWAY_KEY = 'vck_' + 'D'.repeat(40) + 'DPLY';
const WORKSPACE_KEY = 'sk-ant-api03-' + 'W'.repeat(40) + 'WSKY';

/** Gateway on with a deployment API key (no AI_GATEWAY_API_KEY → OIDC). */
function gatewayOn(auth: 'api_key' | 'oidc' = 'api_key') {
  vi.stubEnv('CRUNCH_AI_GATEWAY', undefined);
  vi.stubEnv('VERCEL', auth === 'oidc' ? '1' : undefined);
  vi.stubEnv('AI_GATEWAY_API_KEY', auth === 'api_key' ? GATEWAY_KEY : undefined);
}

const baseURL = (c: unknown) => (c as { baseURL?: string }).baseURL;

describe('deploymentGatewayConfig', () => {
  it.each([
    [{}, false],
    [{ VERCEL: '1' }, true],
    [{ AI_GATEWAY_API_KEY: 'k' }, true],
    [{ VERCEL: '1', CRUNCH_AI_GATEWAY: 'off' }, false],
    [{ AI_GATEWAY_API_KEY: 'k', CRUNCH_AI_GATEWAY: 'OFF' }, false],
    [{ CRUNCH_AI_GATEWAY: 'on' }, true],
    [{ CRUNCH_AI_GATEWAY: 'auto', VERCEL: '1' }, true],
  ])('%j → enabled=%s', (env, enabled) => {
    expect(deploymentGatewayConfig(env).enabled).toBe(enabled);
  });

  it('prefers the API key over OIDC', () => {
    expect(deploymentGatewayConfig({ VERCEL: '1', AI_GATEWAY_API_KEY: 'k' }).auth).toBe('api_key');
    expect(deploymentGatewayConfig({ VERCEL: '1' }).auth).toBe('oidc');
  });
});

describe('model access precedence', () => {
  it('no credential and gateway off: no model access', async () => {
    const admin = await makeActor(db, 'admin');
    vi.stubEnv('AI_GATEWAY_API_KEY', GATEWAY_KEY); // set, but explicitly disabled
    vi.stubEnv('CRUNCH_AI_GATEWAY', 'off');
    await expect(loadWorkspaceClient(db, admin.workspace.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await hasWorkingCredential(db, admin.workspace.id)).toBe(false);
  });

  it('gateway beats none', async () => {
    const admin = await makeActor(db, 'admin');
    gatewayOn();
    const res = await loadWorkspaceClient(db, admin.workspace.id);
    expect(res.source).toBe('deployment_gateway');
    expect(res.config).toEqual({ provider: 'gateway' });
    expect(baseURL(res.client)).toBe(AI_GATEWAY_BASE_URL);
    expect(await hasWorkingCredential(db, admin.workspace.id)).toBe(true);
  });

  it('a working workspace credential beats the gateway', async () => {
    const admin = await makeActor(db, 'admin');
    await saveCredential(db, admin, { provider: 'anthropic', apiKey: WORKSPACE_KEY });
    await db
      .update(providerCredentials)
      .set({ status: 'ok' })
      .where(eq(providerCredentials.workspaceId, admin.workspace.id));
    gatewayOn();
    const res = await loadWorkspaceClient(db, admin.workspace.id);
    expect(res.source).toBe('workspace');
    expect(res.config.provider).toBe('anthropic');
  });

  it('a failing or untested workspace credential falls back to the gateway', async () => {
    const admin = await makeActor(db, 'admin');
    await saveCredential(db, admin, { provider: 'anthropic', apiKey: WORKSPACE_KEY });
    gatewayOn();
    expect((await loadWorkspaceClient(db, admin.workspace.id)).source).toBe('deployment_gateway');
    await db
      .update(providerCredentials)
      .set({ status: 'error' })
      .where(eq(providerCredentials.workspaceId, admin.workspace.id));
    expect((await loadWorkspaceClient(db, admin.workspace.id)).source).toBe('deployment_gateway');
    // With the gateway off, the saved credential is still used (its error surfaces as today).
    vi.stubEnv('CRUNCH_AI_GATEWAY', 'off');
    expect((await loadWorkspaceClient(db, admin.workspace.id)).source).toBe('workspace');
    expect(await hasWorkingCredential(db, admin.workspace.id)).toBe(false);
  });

  it('a workspace AI Gateway key is stored encrypted and used as the workspace credential', async () => {
    const admin = await makeActor(db, 'admin');
    const key = 'vck_' + 'w'.repeat(40) + 'MINE';
    const pub = await saveCredential(db, admin, { provider: 'gateway', apiKey: key });
    expect(pub).toMatchObject({ provider: 'gateway', hint: '…MINE' });
    const [row] = await db.select().from(providerCredentials);
    expect(JSON.stringify(row)).not.toContain(key);
    await db.update(providerCredentials).set({ status: 'ok' });
    const res = await loadWorkspaceClient(db, admin.workspace.id);
    expect(res).toMatchObject({ source: 'workspace', config: { provider: 'gateway' } });
    expect(baseURL(res.client)).toBe(AI_GATEWAY_BASE_URL);
  });
});

// ---------------------------------------------------------------------------------------------
// The proxy on the deployment gateway, through the real client (fetch stubbed)
// ---------------------------------------------------------------------------------------------

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

const post = (path: string, token: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost/api/llm/v1/${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-api-key': 'sandbox-should-not-forward',
      ...headers,
    },
    body: JSON.stringify(body),
  });

interface Upstream {
  url: string;
  headers: Headers;
  body: string;
}

function stubUpstream(response: () => Response): Upstream[] {
  const upstream: Upstream[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const req = new Request(url, init);
      upstream.push({ url: req.url, headers: req.headers, body: await req.text() });
      return response();
    }),
  );
  return upstream;
}

const sseResponse = () =>
  new Response(
    eventsFor('anthropic/claude-sonnet-5.5', { content: [textBlock('hello from gateway')] })
      .map((e) => encodeSse({ event: e.type, data: e }))
      .join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_gw' } },
  );

const body = {
  model: 'claude-sonnet-5-5',
  max_tokens: 100,
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  messages: [{ role: 'user', content: 'hi' }],
  thinking: { type: 'adaptive', display: 'updates' },
  stream: true,
};

const headerDump = (h: Headers) => JSON.stringify([...h.entries()]);

describe('LLM proxy on the deployment gateway', () => {
  it.each([
    ['API key', 'api_key', GATEWAY_KEY],
    ['OIDC token', 'oidc', OIDC_TOKEN],
  ] as const)(
    'injects the %s server-side, maps the model and never leaks it',
    async (_l, auth, secret) => {
      const { token, job } = await setupJob();
      gatewayOn(auth);
      const upstream = stubUpstream(sseResponse);
      const res = await handleMessagesProxy(
        db,
        post('messages', token, body, {
          'anthropic-beta': 'interleaved-thinking-2025-05-14,thinking-display-updates-2026-08-18',
        }),
      );
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('message_stop');
      expect(text).not.toContain(secret);

      expect(upstream).toHaveLength(1);
      const call = upstream[0]!;
      expect(call.url).toBe(`${AI_GATEWAY_BASE_URL}/v1/messages`);
      expect(call.headers.get('authorization')).toBe(`Bearer ${secret}`);
      expect(call.headers.get('anthropic-beta')).toBe(
        'interleaved-thinking-2025-05-14,thinking-display-updates-2026-08-18',
      );
      expect(headerDump(call.headers)).not.toContain(token);
      expect(headerDump(call.headers)).not.toContain('sandbox-should-not-forward');
      const sent = JSON.parse(call.body);
      expect(sent.model).toBe('anthropic/claude-sonnet-5.5');
      // Prompt caching and thinking pass through unchanged.
      expect(sent.system).toEqual(body.system);
      expect(sent.thinking).toEqual(body.thinking);
      expect(call.body).not.toContain(token);

      const [row] = await db.select().from(llmCalls);
      expect(row).toMatchObject({
        ok: true,
        provider: 'gateway',
        model: 'claude-sonnet-5-5',
        jobId: job.id,
      });
      expect(row!.estCostMicros).toBeGreaterThan(0);
    },
  );

  it('still rejects forbidden betas before calling the gateway', async () => {
    const { token } = await setupJob();
    gatewayOn();
    const upstream = stubUpstream(sseResponse);
    const res = await handleMessagesProxy(
      db,
      post('messages', token, body, { 'anthropic-beta': 'mcp-client-2025-11-20' }),
    );
    expect(res.status).toBe(400);
    expect(upstream).toHaveLength(0);
  });

  it('proxies count_tokens to the gateway with the mapped model', async () => {
    const { token } = await setupJob();
    gatewayOn();
    const upstream = stubUpstream(() => Response.json({ input_tokens: 7 }));
    const res = await handleCountTokensProxy(
      db,
      post('messages/count_tokens', token, {
        model: 'claude-haiku-5-5',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(await res.json()).toEqual({ input_tokens: 7 });
    expect(upstream[0]!.url).toBe(`${AI_GATEWAY_BASE_URL}/v1/messages/count_tokens`);
    expect(JSON.parse(upstream[0]!.body).model).toBe('anthropic/claude-haiku-5.5');
    expect(upstream[0]!.headers.get('authorization')).toBe(`Bearer ${GATEWAY_KEY}`);
  });

  it('gateway errors come back without credential material', async () => {
    const { token } = await setupJob();
    gatewayOn();
    stubUpstream(() =>
      Response.json(
        { type: 'error', error: { type: 'authentication_error', message: `bad ${GATEWAY_KEY}` } },
        { status: 401 },
      ),
    );
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handleMessagesProxy(db, post('messages', token, body));
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(GATEWAY_KEY);
    err.mockRestore();
    const [row] = await db.select().from(llmCalls);
    expect(row).toMatchObject({ ok: false, provider: 'gateway' });
  });
});
