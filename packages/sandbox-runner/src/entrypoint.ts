/**
 * The program that runs inside a job sandbox. It is shipped as source text (written to the VM
 * with writeFiles) so it doesn't depend on the app's bundle. It:
 *  - runs the Claude Agent SDK with no built-in tools, only our MCP tools (served by the Job API
 *    over streamable HTTP, authenticated with the job token);
 *  - streams progress to POST /api/jobs/:id/report, then reports the result or error.
 * The SDK's model calls go to ANTHROPIC_BASE_URL (our LLM proxy) with the job token.
 *
 * `main(deps)` takes its dependencies so tests can run this exact source with fakes.
 */

export const SANDBOX_DIR = '/vercel/sandbox';
export const ENTRYPOINT_PATH = `${SANDBOX_DIR}/crunch-job.mjs`;
export const JOB_SPEC_PATH = `${SANDBOX_DIR}/job.json`;

/** What the entrypoint reads from job.json. No secrets: the token comes from the env. */
export interface JobSpec {
  jobId: string;
  kind: string;
  prompt: string;
  systemPrompt: string;
  /** MCP tool names (without the mcp__crunch__ prefix). */
  tools: string[];
  maxTurns: number;
}

export const AGENT_SDK_VERSION = '0.3.318';

export const SANDBOX_PACKAGE_JSON = JSON.stringify(
  {
    name: 'crunch-job',
    private: true,
    type: 'module',
    dependencies: { '@anthropic-ai/claude-agent-sdk': AGENT_SDK_VERSION },
  },
  null,
  2,
);

export const ENTRYPOINT_SOURCE = String.raw`// CrunchDesign job entrypoint (generated; see packages/sandbox-runner/src/entrypoint.ts)
export async function main(deps) {
  const { query, fetch, env, readFile } = deps;
  const spec = JSON.parse(await readFile(${JSON.stringify(JOB_SPEC_PATH)}));
  const base = env.CRUNCH_API_URL + '/api/jobs/' + encodeURIComponent(spec.jobId);
  const auth = { authorization: 'Bearer ' + env.ANTHROPIC_AUTH_TOKEN };
  let failures = 0;
  const report = async (type, data) => {
    try {
      const res = await fetch(base + '/report', {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ type, data }),
      });
      if (res.status === 401 || res.status === 409) throw new Error('job_revoked');
      failures = 0;
    } catch (e) {
      if (e && e.message === 'job_revoked') throw e;
      if (++failures > 20) throw new Error('report_failed');
    }
  };

  const abort = new AbortController();
  let summary = '';
  try {
    await report('status', { phase: 'agent_started' });
    const q = query({
      prompt: spec.prompt,
      options: {
        model: env.ANTHROPIC_MODEL,
        systemPrompt: spec.systemPrompt,
        tools: [],
        mcpServers: { crunch: { type: 'http', url: base + '/mcp', headers: auth } },
        allowedTools: spec.tools.map((t) => 'mcp__crunch__' + t),
        permissionMode: 'dontAsk',
        settingSources: [],
        maxTurns: spec.maxTurns,
        abortController: abort,
        env: { ...env },
      },
    });
    for await (const m of q) {
      if (m.type === 'assistant') {
        for (const b of m.message.content) {
          if (b.type === 'text' && b.text.trim()) await report('log', { text: b.text.slice(0, 4000) });
          else if (b.type === 'tool_use') await report('tool', { name: String(b.name).replace(/^mcp__crunch__/, '') });
        }
      } else if (m.type === 'result') {
        if (m.subtype === 'success') summary = m.result || '';
        else throw new Error('agent_' + m.subtype);
      }
    }
    await report('result', { summary: summary.slice(0, 8000) });
    return 0;
  } catch (e) {
    abort.abort();
    const message = e && e.message ? String(e.message).slice(0, 500) : 'unknown error';
    if (message !== 'job_revoked') await report('error', { message }).catch(() => {});
    return 1;
  }
}

if (process.argv[2] === 'run') {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const fs = await import('node:fs/promises');
  const code = await main({
    query: sdk.query,
    fetch: globalThis.fetch,
    env: process.env,
    readFile: (p) => fs.readFile(p, 'utf8'),
  });
  process.exit(code);
}
`;
