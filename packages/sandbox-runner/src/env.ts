/**
 * The only environment a job sandbox gets (Story 5.2, SPEC D9). It is built from an explicit
 * allowlist, never from process.env, so provider credentials can't leak in by inheritance.
 * Model traffic goes to our LLM proxy with a short-lived, job-scoped token.
 */

export interface SandboxEnvInput {
  /** Public base URL of the app, e.g. https://crunch.example.com (no trailing slash). */
  appUrl: string;
  jobId: string;
  /** Job token (cjt_…), revoked when the job ends. */
  jobToken: string;
  /** Model the agent should use (first-party id; the proxy maps it per provider). */
  model: string;
  /** Cheap model for the SDK's background calls. */
  smallModel: string;
}

export const SANDBOX_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_TELEMETRY',
  'DISABLE_AUTOUPDATER',
  'CRUNCH_API_URL',
  'CRUNCH_JOB_ID',
] as const;

export function buildSandboxEnv(
  i: SandboxEnvInput,
): Record<(typeof SANDBOX_ENV_KEYS)[number], string> {
  const appUrl = i.appUrl.replace(/\/+$/, '');
  return {
    ANTHROPIC_BASE_URL: `${appUrl}/api/llm`,
    ANTHROPIC_AUTH_TOKEN: i.jobToken,
    ANTHROPIC_MODEL: i.model,
    ANTHROPIC_SMALL_FAST_MODEL: i.smallModel,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_AUTOUPDATER: '1',
    CRUNCH_API_URL: appUrl,
    CRUNCH_JOB_ID: i.jobId,
  };
}

/** Names that must never be set inside a sandbox. */
const FORBIDDEN_KEYS =
  /^(ANTHROPIC_API_KEY|AWS_[A-Z_]+|GOOGLE_[A-Z_]+|GCLOUD_[A-Z_]+|AZURE_[A-Z_]+|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)|CREDENTIALS_MASTER_KEYS?|DATABASE_URL|CLERK_SECRET_KEY|BLOB_READ_WRITE_TOKEN|VERCEL_(OIDC_)?TOKEN)$/;

/** Values that look like provider or platform secrets. */
const SECRET_VALUE =
  /(sk-ant-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|"private_key"\s*:)/;

export class SandboxSecretError extends Error {
  override name = 'SandboxSecretError';
}

/** Defense in depth: refuse to start a sandbox whose env or files contain secret-looking data. */
export function assertNoSecrets(
  env: Record<string, string>,
  files: { path: string; content: string }[] = [],
) {
  for (const [k, v] of Object.entries(env)) {
    if (FORBIDDEN_KEYS.test(k))
      throw new SandboxSecretError(`Refusing to pass ${k} into a sandbox`);
    if (SECRET_VALUE.test(v)) throw new SandboxSecretError(`Env ${k} looks like a credential`);
  }
  for (const f of files)
    if (SECRET_VALUE.test(f.content))
      throw new SandboxSecretError(`File ${f.path} looks like it contains a credential`);
}
