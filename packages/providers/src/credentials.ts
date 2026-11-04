/**
 * Workspace BYOK credential shapes for the supported Claude routes.
 *
 * Each credential splits into:
 *  - `config`: non-secret settings (region, project, role ARN), stored as plain JSON
 *  - `secret`: secret material, stored only as an encrypted envelope (@crunch/crypto)
 *
 * Nothing in this module returns secret material to a caller that renders UI;
 * use `toPublicCredential` for anything sent to the browser.
 */
import { z } from 'zod';

export const PROVIDERS = ['anthropic', 'bedrock', 'vertex', 'foundry'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: 'Anthropic API',
  bedrock: 'Amazon Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Microsoft Foundry',
};

const region = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/, 'Invalid region');

// ---- Form input (what an Admin submits) ----

export const anthropicInput = z.object({
  provider: z.literal('anthropic'),
  apiKey: z.string().trim().min(20, 'API key looks too short').max(512),
});

export const bedrockInput = z.discriminatedUnion('authMode', [
  z.object({
    provider: z.literal('bedrock'),
    authMode: z.literal('assume_role'),
    region,
    roleArn: z
      .string()
      .trim()
      .regex(/^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]+$/, 'Invalid IAM role ARN'),
  }),
  z.object({
    provider: z.literal('bedrock'),
    authMode: z.literal('access_keys'),
    region,
    accessKeyId: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{16,128}$/, 'Invalid access key id'),
    secretAccessKey: z.string().trim().min(16).max(256),
  }),
]);

export const vertexInput = z.object({
  provider: z.literal('vertex'),
  projectId: z.string().trim().min(1).max(128),
  region: z.string().trim().min(1).max(64), // "global", "us", "europe-west1", ...
  serviceAccountJson: z
    .string()
    .trim()
    .refine((s) => {
      try {
        const j = JSON.parse(s);
        return j && typeof j.client_email === 'string' && typeof j.private_key === 'string';
      } catch {
        return false;
      }
    }, 'Must be a Google service account JSON key'),
});

export const foundryInput = z.object({
  provider: z.literal('foundry'),
  resource: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9-]+$/, 'Invalid resource name'),
  apiKey: z.string().trim().min(16).max(512),
});

export const credentialInput = z.union([anthropicInput, bedrockInput, vertexInput, foundryInput]);
export type CredentialInput = z.infer<typeof credentialInput>;

// ---- Stored shapes ----

export const storedConfig = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('anthropic') }),
  z.object({
    provider: z.literal('bedrock'),
    region: z.string(),
    authMode: z.enum(['assume_role', 'access_keys']),
    roleArn: z.string().optional(),
    externalId: z.string().optional(),
    accessKeyId: z.string().optional(),
  }),
  z.object({
    provider: z.literal('vertex'),
    projectId: z.string(),
    region: z.string(),
    clientEmail: z.string(),
  }),
  z.object({ provider: z.literal('foundry'), resource: z.string() }),
]);
export type StoredConfig = z.infer<typeof storedConfig>;

export const storedSecret = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('anthropic'), apiKey: z.string() }),
  z.object({ provider: z.literal('bedrock'), secretAccessKey: z.string().optional() }),
  z.object({ provider: z.literal('vertex'), serviceAccountJson: z.string() }),
  z.object({ provider: z.literal('foundry'), apiKey: z.string() }),
]);
export type StoredSecret = z.infer<typeof storedSecret>;

export interface SplitCredential {
  config: StoredConfig;
  /** null when the credential has no secret material (Bedrock assume-role). */
  secret: StoredSecret | null;
  /** Last 4 characters of the primary secret, or a non-secret identifier. Safe to display. */
  hint: string;
}

const last4 = (s: string) => `…${s.slice(-4)}`;

/**
 * Split validated input into stored config, secret and hint.
 * @param externalId server-generated external id for Bedrock role assumption
 */
export function splitCredential(input: CredentialInput, externalId: string): SplitCredential {
  switch (input.provider) {
    case 'anthropic':
      return {
        config: { provider: 'anthropic' },
        secret: { provider: 'anthropic', apiKey: input.apiKey },
        hint: last4(input.apiKey),
      };
    case 'bedrock':
      if (input.authMode === 'assume_role') {
        return {
          config: {
            provider: 'bedrock',
            region: input.region,
            authMode: 'assume_role',
            roleArn: input.roleArn,
            externalId,
          },
          secret: null,
          hint: input.roleArn.split('/').pop() ?? input.roleArn,
        };
      }
      return {
        config: {
          provider: 'bedrock',
          region: input.region,
          authMode: 'access_keys',
          accessKeyId: input.accessKeyId,
        },
        secret: { provider: 'bedrock', secretAccessKey: input.secretAccessKey },
        hint: last4(input.accessKeyId),
      };
    case 'vertex': {
      const sa = JSON.parse(input.serviceAccountJson) as { client_email: string };
      return {
        config: {
          provider: 'vertex',
          projectId: input.projectId,
          region: input.region,
          clientEmail: sa.client_email,
        },
        secret: { provider: 'vertex', serviceAccountJson: input.serviceAccountJson },
        hint: sa.client_email,
      };
    }
    case 'foundry':
      return {
        config: { provider: 'foundry', resource: input.resource },
        secret: { provider: 'foundry', apiKey: input.apiKey },
        hint: last4(input.apiKey),
      };
  }
}

export type CredentialStatus = 'untested' | 'ok' | 'error';

/** The only credential shape allowed to reach the browser. */
export interface PublicCredential {
  provider: Provider;
  providerLabel: string;
  hint: string;
  status: CredentialStatus;
  lastTestedAt: string | null;
  lastError: string | null;
  /** Non-secret settings Admins need to see (region, role ARN, external id for the trust policy). */
  details: Record<string, string>;
  updatedAt: string;
}

export function toPublicCredential(row: {
  provider: Provider;
  config: unknown;
  hint: string;
  status: CredentialStatus;
  lastTestedAt: Date | null;
  lastError: string | null;
  updatedAt: Date;
}): PublicCredential {
  const cfg = storedConfig.parse(row.config);
  const details: Record<string, string> = {};
  switch (cfg.provider) {
    case 'bedrock':
      details.Region = cfg.region;
      details['Auth mode'] = cfg.authMode === 'assume_role' ? 'Assume IAM role' : 'Access keys';
      if (cfg.roleArn) details['Role ARN'] = cfg.roleArn;
      if (cfg.externalId) details['External ID'] = cfg.externalId;
      if (cfg.accessKeyId) details['Access key'] = last4(cfg.accessKeyId);
      break;
    case 'vertex':
      details.Project = cfg.projectId;
      details.Region = cfg.region;
      details['Service account'] = cfg.clientEmail;
      break;
    case 'foundry':
      details.Resource = cfg.resource;
      break;
  }
  return {
    provider: row.provider,
    providerLabel: PROVIDER_LABELS[row.provider],
    hint: row.hint,
    status: row.status,
    lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
    lastError: row.lastError,
    details,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Every secret string inside a credential, used to scrub them from error messages and logs. */
export function secretValues(secret: StoredSecret | null): string[] {
  if (!secret) return [];
  return Object.entries(secret)
    .filter(([k, v]) => k !== 'provider' && typeof v === 'string' && v.length >= 8)
    .flatMap(([, v]) => {
      const s = v as string;
      // Also scrub the private key inside a service-account JSON.
      try {
        const j = JSON.parse(s);
        if (j && typeof j.private_key === 'string')
          return [s, j.private_key, j.private_key_id].filter(Boolean);
      } catch {
        /* not JSON */
      }
      return [s];
    });
}

export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('[REDACTED]');
  // Belt and braces: well-known key prefixes.
  return out
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      '[REDACTED]',
    );
}
