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
  /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|AWS_[A-Z_]+|GOOGLE_[A-Z_]+|GCLOUD_[A-Z_]+|AZURE_[A-Z_]+|FOUNDRY_[A-Z_]+|ANTHROPIC_FOUNDRY_[A-Z_]+|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)|CREDENTIALS_MASTER_KEYS?|CREDENTIALS_ACTIVE_KEY_ID|DATABASE_URL|POSTGRES_[A-Z_]+|CLERK_SECRET_KEY|BLOB_READ_WRITE_TOKEN|CRON_SECRET|STRIPE_[A-Z_]+|VERCEL_(OIDC_)?TOKEN|VERCEL_AUTOMATION_BYPASS_SECRET)$/;

/**
 * Distinctive credential shapes, checked in env values and files (prompts and specs included):
 * Anthropic keys, AWS access key ids (long-term AKIA and STS ASIA), PEM private keys and
 * service-account JSON, Stripe secret/restricted keys, GitHub and Slack tokens, Google API keys
 * and OAuth access tokens.
 */
const SECRET_VALUE = new RegExp(
  [
    'sk-ant-[A-Za-z0-9_-]{8,}',
    '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b',
    '-----BEGIN [A-Z ]*PRIVATE KEY-----',
    '"private_key"\\s*:',
    '\\b[sr]k_(?:live|test)_[0-9A-Za-z]{10,}',
    '\\bgh[pousr]_[0-9A-Za-z]{30,}',
    '\\bgithub_pat_[0-9A-Za-z_]{20,}',
    '\\bxox[abpres]-[0-9A-Za-z-]{10,}',
    '\\bAIza[0-9A-Za-z_-]{35}',
    '\\bya29\\.[0-9A-Za-z_-]{20,}',
  ].join('|'),
);

/**
 * Whole-value shapes too generic to search for inside text, but suspicious as an entire env
 * value: an AWS secret access key (40 base64 chars) or an Azure / Foundry API key (32 hex chars,
 * or the newer 84-char form).
 */
const SECRET_ENV_VALUE = /^(?:[A-Za-z0-9/+]{40}|[0-9a-fA-F]{32}|[A-Za-z0-9]{84})$/;

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
    if (SECRET_VALUE.test(v) || SECRET_ENV_VALUE.test(v))
      throw new SandboxSecretError(`Env ${k} looks like a credential`);
  }
  for (const f of files)
    if (SECRET_VALUE.test(f.content))
      throw new SandboxSecretError(`File ${f.path} looks like it contains a credential`);
}
