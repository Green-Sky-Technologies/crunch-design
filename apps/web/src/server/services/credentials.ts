/**
 * Workspace model credentials (Story 1.4). Secrets are encrypted with envelope
 * encryption, bound to the workspace id, and never returned by any function exported
 * for UI use. `loadWorkspaceClient` is the only path to decrypted material; it's meant
 * for the LLM proxy (Story 5.2).
 *
 * Model access precedence: the workspace's own working credential (status `ok`), then the
 * deployment's Vercel AI Gateway when enabled (ai-gateway.ts), then any saved credential that
 * hasn't passed a test (so its error surfaces), else none.
 */
import { assertCan } from '@crunch/authz';
import { decryptSecret, encryptSecret, type Keyring } from '@crunch/crypto';
import { eq, providerCredentials, workspaceAwsExternalIds, type Db } from '@crunch/db';
import {
  buildClient,
  credentialInput,
  splitCredential,
  storedConfig,
  storedSecret,
  testConnection,
  toPublicCredential,
  type BuildOptions,
  type ClaudeClient,
  type PublicCredential,
  type StoredConfig,
  type StoredSecret,
  type TestResult,
} from '@crunch/providers';
import { randomBytes } from 'node:crypto';
import {
  deploymentGatewayConfig,
  loadDeploymentGatewayClient,
  type GatewayClientDeps,
} from './ai-gateway';
import { NotFoundError, ValidationError, type Actor } from './types';

const aadFor = (workspaceId: string) => `provider_credential:${workspaceId}`;

export interface CredentialDeps {
  keyring?: Keyring;
  /** Injected for tests; defaults to a real provider call. */
  tester?: (
    config: StoredConfig,
    secret: StoredSecret | null,
    opts: BuildOptions,
  ) => Promise<TestResult>;
}

export async function getExternalId(db: Db, workspaceId: string): Promise<string> {
  const [row] = await db
    .select()
    .from(workspaceAwsExternalIds)
    .where(eq(workspaceAwsExternalIds.workspaceId, workspaceId))
    .limit(1);
  if (row) return row.externalId;
  const externalId = `crunch-${randomBytes(16).toString('hex')}`;
  await db
    .insert(workspaceAwsExternalIds)
    .values({ workspaceId, externalId })
    .onConflictDoNothing();
  return getExternalId(db, workspaceId);
}

export async function getPublicCredential(db: Db, actor: Actor): Promise<PublicCredential | null> {
  assertCan(actor.role, 'workspace:read');
  const [row] = await db
    .select()
    .from(providerCredentials)
    .where(eq(providerCredentials.workspaceId, actor.workspace.id))
    .limit(1);
  return row ? toPublicCredential(row) : null;
}

/**
 * Whether the workspace can use the agent: its own working credential, or the deployment
 * gateway. Safe for any member to call.
 */
export async function hasWorkingCredential(
  db: Db,
  workspaceId: string,
  opts: { env?: GatewayClientDeps['env'] } = {},
): Promise<boolean> {
  if (deploymentGatewayConfig(opts.env).enabled) return true;
  const [row] = await db
    .select({ status: providerCredentials.status })
    .from(providerCredentials)
    .where(eq(providerCredentials.workspaceId, workspaceId))
    .limit(1);
  return row?.status === 'ok';
}

export async function saveCredential(
  db: Db,
  actor: Actor,
  rawInput: unknown,
  deps: CredentialDeps = {},
): Promise<PublicCredential> {
  assertCan(actor.role, 'workspace:manage_credentials');
  const parsed = credentialInput.safeParse(rawInput);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? 'form');
      (fieldErrors[key] ??= []).push(issue.message);
    }
    throw new ValidationError('Please fix the highlighted fields', fieldErrors);
  }
  const externalId = await getExternalId(db, actor.workspace.id);
  const { config, secret, hint } = splitCredential(parsed.data, externalId);
  const secretEnvelope = secret
    ? encryptSecret(JSON.stringify(secret), aadFor(actor.workspace.id), deps.keyring)
    : null;

  const values = {
    provider: config.provider,
    config,
    secretEnvelope,
    hint,
    status: 'untested' as const,
    lastTestedAt: null,
    lastError: null,
    createdBy: actor.userId,
  };
  const [row] = await db
    .insert(providerCredentials)
    .values({ workspaceId: actor.workspace.id, ...values })
    .onConflictDoUpdate({ target: providerCredentials.workspaceId, set: values })
    .returning();
  return toPublicCredential(row!);
}

async function loadDecrypted(db: Db, workspaceId: string, keyring?: Keyring) {
  const [row] = await db
    .select()
    .from(providerCredentials)
    .where(eq(providerCredentials.workspaceId, workspaceId))
    .limit(1);
  if (!row) throw new NotFoundError('No model credential configured for this workspace');
  const config = storedConfig.parse(row.config);
  const secret = row.secretEnvelope
    ? storedSecret.parse(
        JSON.parse(decryptSecret(row.secretEnvelope, aadFor(workspaceId), keyring)),
      )
    : null;
  return { row, config, secret };
}

export async function testCredential(
  db: Db,
  actor: Actor,
  deps: CredentialDeps = {},
): Promise<PublicCredential> {
  assertCan(actor.role, 'workspace:manage_credentials');
  const { config, secret } = await loadDecrypted(db, actor.workspace.id, deps.keyring);
  const tester = deps.tester ?? testConnection;
  const result = await tester(config, secret, { sessionName: `crunch-test-${actor.workspace.id}` });
  const [row] = await db
    .update(providerCredentials)
    .set({
      status: result.ok ? 'ok' : 'error',
      lastTestedAt: new Date(),
      lastError: result.ok ? null : result.error,
    })
    .where(eq(providerCredentials.workspaceId, actor.workspace.id))
    .returning();
  return toPublicCredential(row!);
}

export async function deleteCredential(db: Db, actor: Actor): Promise<void> {
  assertCan(actor.role, 'workspace:manage_credentials');
  await db
    .delete(providerCredentials)
    .where(eq(providerCredentials.workspaceId, actor.workspace.id));
}

export type ModelAccessSource = 'workspace' | 'deployment_gateway';

/**
 * SERVER-ONLY: build a live client for the workspace. For the LLM proxy (Story 5.2).
 * Never hand the result, or anything derived from the secret, to a sandbox or the browser.
 * Precedence is described at the top of this file.
 */
export async function loadWorkspaceClient(
  db: Db,
  workspaceId: string,
  opts: BuildOptions & { keyring?: Keyring; gateway?: GatewayClientDeps } = {},
): Promise<{ client: ClaudeClient; config: StoredConfig; source: ModelAccessSource }> {
  const [row] = await db
    .select({ status: providerCredentials.status })
    .from(providerCredentials)
    .where(eq(providerCredentials.workspaceId, workspaceId))
    .limit(1);
  if (row?.status !== 'ok') {
    const gateway = loadDeploymentGatewayClient(opts.gateway);
    if (gateway)
      return { client: gateway, config: { provider: 'gateway' }, source: 'deployment_gateway' };
  }
  const { config, secret } = await loadDecrypted(db, workspaceId, opts.keyring);
  return { client: await buildClient(config, secret, opts), config, source: 'workspace' };
}
