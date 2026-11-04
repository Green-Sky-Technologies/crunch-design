import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  AI_GATEWAY_BASE_URL,
  buildClient,
  buildGatewayClient,
  credentialInput,
  MODEL_TIERS,
  providerModelId,
  redact,
  secretValues,
  splitCredential,
  testConnection,
  toPublicCredential,
} from './index';

const snapshot = JSON.parse(
  readFileSync(new URL('./gateway-models.snapshot.json', import.meta.url), 'utf8'),
) as { ids: string[] };

const KEY = 'vck_' + 'g'.repeat(40) + 'GATE';

describe('AI Gateway model ids', () => {
  it.each(Object.entries(MODEL_TIERS))('maps the %s tier to a live gateway id', (_tier, id) => {
    expect(snapshot.ids).toContain(providerModelId('gateway', id));
  });

  it('uses the anthropic/ prefix and a dotted version', () => {
    expect(providerModelId('gateway', 'claude-opus-5-5')).toBe('anthropic/claude-opus-5.5');
    expect(providerModelId('gateway', 'claude-fable-5-1')).toBe('anthropic/claude-fable-5.1');
    expect(providerModelId('gateway', 'claude-opus-5')).toBe('anthropic/claude-opus-5');
    expect(providerModelId('anthropic', 'claude-opus-5-5')).toBe('claude-opus-5-5');
  });
});

describe('AI Gateway credential', () => {
  it('validates input', () => {
    expect(credentialInput.safeParse({ provider: 'gateway', apiKey: KEY }).success).toBe(true);
    expect(credentialInput.safeParse({ provider: 'gateway', apiKey: 'short' }).success).toBe(false);
  });

  it('keeps the key in the secret only and shows a hint', () => {
    const split = splitCredential({ provider: 'gateway', apiKey: KEY }, 'ext');
    expect(split.config).toEqual({ provider: 'gateway' });
    expect(split.secret).toEqual({ provider: 'gateway', apiKey: KEY });
    expect(split.hint).toBe('…GATE');
    const pub = toPublicCredential({
      provider: 'gateway',
      config: split.config,
      hint: split.hint,
      status: 'ok',
      lastTestedAt: null,
      lastError: null,
      updatedAt: new Date(),
    });
    expect(pub.providerLabel).toBe('Vercel AI Gateway');
    expect(JSON.stringify(pub)).not.toContain(KEY);
  });

  it('redacts gateway keys from error text', () => {
    expect(redact(`bad ${KEY}`, secretValues({ provider: 'gateway', apiKey: KEY }))).not.toContain(
      KEY,
    );
    expect(redact(`bad ${KEY}`, [])).not.toContain(KEY);
  });

  it('builds an Anthropic client on the gateway base URL', async () => {
    const client = await buildClient({ provider: 'gateway' }, { provider: 'gateway', apiKey: KEY });
    expect('baseURL' in client && client.baseURL).toBe(AI_GATEWAY_BASE_URL);
    await expect(buildClient({ provider: 'gateway' }, null)).rejects.toThrow(/AI Gateway/);
  });

  it('tests the key with a count_tokens call on the gateway model id', async () => {
    const calls: { url: string; auth: string | null; body: string }[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const req = new Request(url, init);
      calls.push({ url: req.url, auth: req.headers.get('authorization'), body: await req.text() });
      return Response.json({ input_tokens: 3 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const res = await testConnection(
        { provider: 'gateway' },
        { provider: 'gateway', apiKey: KEY },
      );
      expect(res).toEqual({ ok: true, model: 'anthropic/claude-haiku-5.5' });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(`${AI_GATEWAY_BASE_URL}/v1/messages/count_tokens`);
      expect(calls[0]!.auth).toBe(`Bearer ${KEY}`);
      expect(JSON.parse(calls[0]!.body).model).toBe('anthropic/claude-haiku-5.5');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('calls a token getter before each request (OIDC tokens expire)', async () => {
    let n = 0;
    const seen: (string | null)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        seen.push(new Request(url, init).headers.get('authorization'));
        return Response.json({ input_tokens: 1 });
      }),
    );
    try {
      const client = buildGatewayClient(async () => `oidc-${++n}`);
      const body = { model: 'anthropic/claude-haiku-5.5', messages: [] };
      await client.messages.countTokens(body);
      await client.messages.countTokens(body);
      expect(seen).toEqual(['Bearer oidc-1', 'Bearer oidc-2']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
