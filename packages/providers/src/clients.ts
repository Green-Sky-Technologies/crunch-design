/**
 * Build a Claude client for a workspace credential, and test it.
 *
 * Every route exposes the same `messages` surface. The connection test calls
 * `messages.countTokens`, which every route supports and which costs nothing.
 */
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { AnthropicFoundry } from '@anthropic-ai/foundry-sdk';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import { GoogleAuth } from 'google-auth-library';
import { redact, secretValues, type StoredConfig, type StoredSecret } from './credentials';

export type ClaudeClient = Anthropic | AnthropicBedrockMantle | AnthropicVertex | AnthropicFoundry;

/** Model tiers used by task-based defaults (see SPEC §2, Story 5.9). */
export const MODEL_TIERS = {
  generation: 'claude-opus-5-5',
  interactive: 'claude-sonnet-5-5',
  utility: 'claude-haiku-5-5',
} as const;
export type ModelTier = keyof typeof MODEL_TIERS;

/** Map a first-party model id to the id a provider route expects. */
export function providerModelId(provider: StoredConfig['provider'], model: string): string {
  return provider === 'bedrock' ? `anthropic.${model}` : model;
}

export interface BuildOptions {
  /** Session name recorded in CloudTrail for Bedrock role assumption. */
  sessionName?: string;
  /** Role session duration (seconds) for Bedrock assume-role. */
  sessionSeconds?: number;
  /** Override for tests. */
  sts?: Pick<STSClient, 'send'>;
}

export async function buildClient(
  config: StoredConfig,
  secret: StoredSecret | null,
  opts: BuildOptions = {},
): Promise<ClaudeClient> {
  switch (config.provider) {
    case 'anthropic': {
      if (secret?.provider !== 'anthropic') throw new Error('Missing Anthropic API key');
      return new Anthropic({ apiKey: secret.apiKey, maxRetries: 1 });
    }
    case 'bedrock': {
      if (config.authMode === 'access_keys') {
        if (secret?.provider !== 'bedrock' || !secret.secretAccessKey || !config.accessKeyId) {
          throw new Error('Missing AWS access keys');
        }
        return new AnthropicBedrockMantle({
          awsRegion: config.region,
          awsAccessKey: config.accessKeyId,
          awsSecretAccessKey: secret.secretAccessKey,
          maxRetries: 1,
        });
      }
      if (!config.roleArn || !config.externalId) throw new Error('Missing role ARN or external ID');
      // Our own AWS identity (from the default provider chain) assumes the customer's role.
      const sts = opts.sts ?? new STSClient({ region: config.region });
      const res = await sts.send(
        new AssumeRoleCommand({
          RoleArn: config.roleArn,
          ExternalId: config.externalId,
          RoleSessionName: (opts.sessionName ?? 'crunchdesign')
            .replace(/[^\w+=,.@-]/g, '-')
            .slice(0, 64),
          DurationSeconds: opts.sessionSeconds ?? 900,
        }),
      );
      const c = res.Credentials;
      if (!c?.AccessKeyId || !c.SecretAccessKey)
        throw new Error('AssumeRole returned no credentials');
      return new AnthropicBedrockMantle({
        awsRegion: config.region,
        awsAccessKey: c.AccessKeyId,
        awsSecretAccessKey: c.SecretAccessKey,
        awsSessionToken: c.SessionToken ?? null,
        maxRetries: 1,
      });
    }
    case 'vertex': {
      if (secret?.provider !== 'vertex') throw new Error('Missing service account key');
      const googleAuth = new GoogleAuth({
        credentials: JSON.parse(secret.serviceAccountJson),
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
      return new AnthropicVertex({
        projectId: config.projectId,
        region: config.region,
        googleAuth,
        maxRetries: 1,
      });
    }
    case 'foundry': {
      if (secret?.provider !== 'foundry') throw new Error('Missing Foundry API key');
      return new AnthropicFoundry({
        apiKey: secret.apiKey,
        resource: config.resource,
        maxRetries: 1,
      });
    }
  }
}

export type TestResult = { ok: true; model: string } | { ok: false; error: string };

/** Validate a credential with a free token-count call. Errors are redacted before they're returned. */
export async function testConnection(
  config: StoredConfig,
  secret: StoredSecret | null,
  opts: BuildOptions & { model?: string; client?: ClaudeClient } = {},
): Promise<TestResult> {
  const model = providerModelId(config.provider, opts.model ?? MODEL_TIERS.utility);
  try {
    const client = opts.client ?? (await buildClient(config, secret, opts));
    await client.messages.countTokens({ model, messages: [{ role: 'user', content: 'ping' }] });
    return { ok: true, model };
  } catch (err) {
    return { ok: false, error: describeError(err, secretValues(secret)) };
  }
}

function describeError(err: unknown, secrets: string[]): string {
  let msg: string;
  if (err instanceof Anthropic.APIError) {
    const status = err.status ? `HTTP ${err.status}` : 'Request failed';
    const hint =
      err.status === 401 || err.status === 403
        ? 'The credential was rejected. Check the key or role permissions.'
        : err.status === 404
          ? 'The model or endpoint was not found. Check region, project, or model access.'
          : err.status === 429
            ? 'Rate limited by the provider. Try again shortly.'
            : '';
    msg = [status, hint, err.message].filter(Boolean).join(' — ');
  } else if (err instanceof Error) {
    msg = `${err.name}: ${err.message}`;
  } else {
    msg = 'Unknown error';
  }
  return redact(msg, secrets).slice(0, 500);
}
