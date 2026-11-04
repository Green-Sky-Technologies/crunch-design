/**
 * JobRunner on Vercel Sandbox (Story 5.1). One Firecracker microVM per job.
 *
 * The sandbox gets: the entrypoint, a job spec (prompt + system prompt, no secrets), and an
 * allowlisted env with the LLM proxy URL and a job token. Egress is limited to the app and the
 * npm registry. Persistence of jobs and events lives in the app (services/jobs.ts).
 */
import type { JobRunner, StartJob } from '@crunch/contracts';
import { assertNoSecrets, buildSandboxEnv } from './env';
import {
  ENTRYPOINT_PATH,
  ENTRYPOINT_SOURCE,
  JOB_SPEC_PATH,
  SANDBOX_DIR,
  SANDBOX_PACKAGE_JSON,
  type JobSpec,
} from './entrypoint';

/** The slice of a sandbox we use (the real @vercel/sandbox Sandbox satisfies it). */
export interface SandboxHandle {
  readonly name: string;
  readonly status: string;
  writeFiles(files: { path: string; content: Uint8Array | string; mode?: number }[]): Promise<void>;
  runCommand(params: {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    detached: true;
  }): Promise<unknown>;
  stop(): Promise<unknown>;
}

export interface CreateSandboxParams {
  timeout: number;
  resources: { vcpus: number };
  persistent: false;
  env: Record<string, string>;
  /** Allowed egress hosts; the record form attaches header transforms at the firewall. */
  networkPolicy: {
    allow: string[] | Record<string, { transform: { headers: Record<string, string> }[] }[]>;
  };
  tags: Record<string, string>;
}

export interface SandboxApi {
  create(params: CreateSandboxParams): Promise<SandboxHandle>;
  get(name: string): Promise<SandboxHandle>;
}

/** Default SandboxApi over @vercel/sandbox (OIDC auth on Vercel; VERCEL_TOKEN etc. elsewhere). */
export async function vercelSandboxApi(): Promise<SandboxApi> {
  const { Sandbox } = await import('@vercel/sandbox');
  return {
    create: async (p) =>
      (await Sandbox.create(p as Parameters<typeof Sandbox.create>[0])) as unknown as SandboxHandle,
    get: async (name) => (await Sandbox.get({ name, resume: false })) as unknown as SandboxHandle,
  };
}

export interface PreparedJob {
  /** Short-lived job token (plaintext; hashed at rest by the app). */
  jobToken: string;
  model: string;
  smallModel: string;
  spec: Omit<JobSpec, 'jobId' | 'kind'>;
}

export interface VercelSandboxRunnerOptions {
  /** Public app URL the sandbox calls back to. */
  appUrl: string;
  /** Issue a token and build the spec for a job (implemented by the app). */
  prepare(job: StartJob): Promise<PreparedJob>;
  api?: SandboxApi | (() => Promise<SandboxApi>);
  vcpus?: number;
  /** Extra hosts the sandbox may reach (the app host and npm are always allowed). */
  allowHosts?: string[];
  /**
   * Vercel "Protection Bypass for Automation" secret for a protected preview. It is injected as
   * the x-vercel-protection-bypass header by the sandbox egress firewall on requests to the app
   * host only, so it never enters the VM (credential brokering).
   */
  protectionBypassSecret?: string;
}

const LIVE_STATUSES = new Set(['pending', 'running']);

export function networkPolicyFor(
  appHost: string,
  extraHosts: string[],
  bypassSecret?: string,
): CreateSandboxParams['networkPolicy'] {
  const hosts = [appHost, 'registry.npmjs.org', ...extraHosts];
  if (!bypassSecret) return { allow: hosts };
  return {
    allow: Object.fromEntries(
      hosts.map((h) => [
        h,
        h === appHost
          ? [{ transform: [{ headers: { 'x-vercel-protection-bypass': bypassSecret } }] }]
          : [],
      ]),
    ) as CreateSandboxParams['networkPolicy']['allow'],
  };
}

export class VercelSandboxRunner implements JobRunner {
  private apiPromise: Promise<SandboxApi> | null = null;

  constructor(private readonly opts: VercelSandboxRunnerOptions) {}

  private api(): Promise<SandboxApi> {
    const a = this.opts.api;
    this.apiPromise ??= !a
      ? vercelSandboxApi()
      : typeof a === 'function'
        ? a()
        : Promise.resolve(a);
    return this.apiPromise;
  }

  async start(job: StartJob): Promise<{ sandboxId: string }> {
    const prepared = await this.opts.prepare(job);
    const env = buildSandboxEnv({
      appUrl: this.opts.appUrl,
      jobId: job.jobId,
      jobToken: prepared.jobToken,
      model: prepared.model,
      smallModel: prepared.smallModel,
    });
    const spec: JobSpec = { jobId: job.jobId, kind: job.kind, ...prepared.spec };
    const files = [
      { path: `${SANDBOX_DIR}/package.json`, content: SANDBOX_PACKAGE_JSON },
      { path: JOB_SPEC_PATH, content: JSON.stringify(spec) },
      { path: ENTRYPOINT_PATH, content: ENTRYPOINT_SOURCE },
    ];
    assertNoSecrets(env, files);

    const appHost = new URL(this.opts.appUrl).host;
    const api = await this.api();
    const sandbox = await api.create({
      timeout: job.timeoutSeconds * 1000,
      resources: { vcpus: this.opts.vcpus ?? 2 },
      persistent: false,
      env,
      networkPolicy: networkPolicyFor(
        appHost,
        this.opts.allowHosts ?? [],
        this.opts.protectionBypassSecret,
      ),
      tags: { crunchJob: job.jobId, workspace: job.workspaceId },
    });
    try {
      await sandbox.writeFiles(
        files.map((f) => ({ path: f.path, content: Buffer.from(f.content) })),
      );
      await sandbox.runCommand({
        cmd: 'bash',
        args: [
          '-c',
          `cd ${SANDBOX_DIR} && npm install --no-audit --no-fund --silent && exec node ${ENTRYPOINT_PATH} run`,
        ],
        cwd: SANDBOX_DIR,
        detached: true,
      });
    } catch (e) {
      await sandbox.stop().catch(() => {});
      throw e;
    }
    return { sandboxId: sandbox.name };
  }

  async cancel(_jobId: string, sandboxId: string): Promise<void> {
    const api = await this.api();
    const sandbox = await api.get(sandboxId).catch(() => null);
    await sandbox?.stop();
  }

  async isAlive(sandboxId: string): Promise<boolean> {
    const api = await this.api();
    try {
      return LIVE_STATUSES.has((await api.get(sandboxId)).status);
    } catch {
      return false;
    }
  }
}
