import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  assertNoSecrets,
  ENTRYPOINT_SOURCE,
  JOB_SPEC_PATH,
  recordingSandboxApi,
  SandboxSecretError,
  VercelSandboxRunner,
  type PreparedJob,
} from './index';

const job = {
  jobId: '11111111-1111-4111-8111-111111111111',
  workspaceId: 'ws',
  kind: 'generate' as const,
  input: { prompt: 'x' },
  timeoutSeconds: 600,
};

const prepared = (over: Partial<PreparedJob['spec']> = {}): PreparedJob => ({
  jobToken: 'cjt_test-token',
  model: 'claude-opus-5-5',
  smallModel: 'claude-haiku-5-5',
  spec: {
    prompt: 'Design a pricing page',
    systemPrompt: 'sys',
    tools: ['get_outline'],
    maxTurns: 40,
    ...over,
  },
});

describe('VercelSandboxRunner', () => {
  it('starts a locked-down sandbox with only the proxy URL and a job token', async () => {
    const realKey = 'sk-ant-api03-' + 'R'.repeat(40);
    vi.stubEnv('ANTHROPIC_API_KEY', realKey);
    const api = recordingSandboxApi();
    const runner = new VercelSandboxRunner({
      appUrl: 'https://app.example.com/',
      api,
      prepare: async () => prepared(),
    });
    const { sandboxId } = await runner.start(job);
    const rec = api.sandboxes.get(sandboxId)!;
    expect(rec.params).toMatchObject({
      timeout: 600_000,
      persistent: false,
      networkPolicy: { allow: ['app.example.com', 'registry.npmjs.org'] },
      env: {
        ANTHROPIC_BASE_URL: 'https://app.example.com/api/llm',
        ANTHROPIC_AUTH_TOKEN: 'cjt_test-token',
        ANTHROPIC_MODEL: 'claude-opus-5-5',
        CRUNCH_JOB_ID: job.jobId,
      },
    });
    expect(rec.params.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(JSON.stringify(rec)).not.toContain(realKey);
    expect(rec.files.map((f) => f.path)).toContain(JOB_SPEC_PATH);
    expect(rec.commands[0]).toMatchObject({ cmd: 'bash', detached: true });
    expect(await runner.isAlive(sandboxId)).toBe(true);
    await runner.cancel(job.jobId, sandboxId);
    expect(rec.stopped).toBe(true);
    expect(await runner.isAlive(sandboxId)).toBe(false);
    expect(await runner.isAlive('missing')).toBe(false);
    vi.unstubAllEnvs();
  });

  it('refuses to start when anything sent to the sandbox looks like a credential', async () => {
    const api = recordingSandboxApi();
    const runner = new VercelSandboxRunner({
      appUrl: 'https://app.example.com',
      api,
      prepare: async () => prepared({ prompt: 'use sk-ant-api03-LEAKEDLEAKEDLEAKED' }),
    });
    await expect(runner.start(job)).rejects.toBeInstanceOf(SandboxSecretError);
    expect(api.sandboxes.size).toBe(0);
    expect(() => assertNoSecrets({ AWS_SECRET_ACCESS_KEY: 'x' })).toThrow(SandboxSecretError);
    expect(() =>
      assertNoSecrets({ OK: 'fine' }, [{ path: 'a', content: '"private_key": "x"' }]),
    ).toThrow();
  });
});

describe('assertNoSecrets patterns (defense in depth)', () => {
  const fake = (prefix: string, n: number, ch = 'A') => prefix + ch.repeat(n);
  it.each([
    ['STS key id', { X: fake('ASIA', 16) }],
    ['AWS key id', { X: fake('AKIA', 16) }],
    ['AWS secret key shape', { X: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }],
    ['Azure/Foundry key', { X: '0123456789abcdef0123456789abcdef' }],
    ['Stripe live key', { X: fake('sk_live_', 24, 'x') }],
    ['GitHub token', { X: fake('ghp_', 36, 'x') }],
    ['Google API key', { X: fake('AIza', 35, 'x') }],
    ['forbidden name', { AZURE_OPENAI_KEY: 'x' }],
    ['forbidden name (Foundry)', { ANTHROPIC_FOUNDRY_API_KEY: 'x' }],
  ])('rejects %s in env', (_l, env) => {
    expect(() => assertNoSecrets(env as Record<string, string>)).toThrow(SandboxSecretError);
  });

  it('rejects distinctive shapes inside files, but not ordinary prompts', () => {
    expect(() =>
      assertNoSecrets({}, [{ path: 'job.json', content: `use ${fake('rk_test_', 20, 'y')}` }]),
    ).toThrow();
    expect(() =>
      assertNoSecrets({}, [{ path: 'job.json', content: `token ${fake('ASIA', 16, 'Q')} here` }]),
    ).toThrow();
    expect(() =>
      assertNoSecrets(
        {
          ANTHROPIC_AUTH_TOKEN: 'cjt_' + 'a'.repeat(43),
          CRUNCH_JOB_ID: '11111111-1111-4111-8111-111111111111',
          ANTHROPIC_MODEL: 'claude-opus-5-5',
        },
        [
          {
            path: 'job.json',
            content:
              'Design a pricing page with three tiers and a 0123456789abcdef0123456789abcdef hash',
          },
        ],
      ),
    ).not.toThrow();
  });
});

describe('sandbox entrypoint', () => {
  async function load() {
    const dir = mkdtempSync(join(tmpdir(), 'crunch-entry-'));
    const file = join(dir, 'entry.mjs');
    writeFileSync(file, ENTRYPOINT_SOURCE);
    return (await import(pathToFileURL(file).href)) as {
      main: (deps: unknown) => Promise<number>;
    };
  }

  const env = {
    CRUNCH_API_URL: 'https://app.example.com',
    ANTHROPIC_AUTH_TOKEN: 'cjt_tok',
    ANTHROPIC_MODEL: 'claude-opus-5-5',
  };
  const spec = {
    jobId: 'j1',
    kind: 'generate',
    prompt: 'P',
    systemPrompt: 'S',
    tools: ['insert_frame'],
    maxTurns: 5,
  };

  it('runs the Agent SDK with only our MCP tools and reports progress and the result', async () => {
    const { main } = await load();
    const reports: { type: string; data: unknown }[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://app.example.com/api/jobs/j1/report');
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer cjt_tok');
      reports.push(JSON.parse(String(init.body)));
      return new Response('{}', { status: 200 });
    });
    let options: Record<string, unknown> = {};
    const query = ({ options: o }: { options: Record<string, unknown> }) => {
      options = o;
      return (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Building' }] } };
        yield {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'mcp__crunch__insert_frame' }] },
        };
        yield { type: 'result', subtype: 'success', result: 'Created 1 frame' };
      })();
    };
    const code = await main({ query, fetch, env, readFile: async () => JSON.stringify(spec) });
    expect(code).toBe(0);
    expect(options).toMatchObject({
      tools: [],
      allowedTools: ['mcp__crunch__insert_frame'],
      permissionMode: 'dontAsk',
      settingSources: [],
      mcpServers: {
        crunch: {
          type: 'http',
          url: 'https://app.example.com/api/jobs/j1/mcp',
          headers: { authorization: 'Bearer cjt_tok' },
        },
      },
    });
    expect(reports.map((r) => r.type)).toEqual(['progress', 'log', 'tool', 'result']);
    expect(reports.at(-1)!.data).toEqual({ summary: 'Created 1 frame' });
  });

  it('reports errors and stops when the job token is revoked', async () => {
    const { main } = await load();
    const reports: string[] = [];
    const failing = () =>
      (async function* () {
        yield { type: 'result', subtype: 'error_max_turns' };
      })();
    const ok = vi.fn(async (_u: string, init: RequestInit) => {
      reports.push(JSON.parse(String(init.body)).type);
      return new Response('{}');
    });
    expect(
      await main({ query: failing, fetch: ok, env, readFile: async () => JSON.stringify(spec) }),
    ).toBe(1);
    expect(reports).toEqual(['progress', 'error']);

    const revoked = vi.fn(async () => new Response('{}', { status: 401 }));
    expect(
      await main({
        query: failing,
        fetch: revoked,
        env,
        readFile: async () => JSON.stringify(spec),
      }),
    ).toBe(1);
  });
});
