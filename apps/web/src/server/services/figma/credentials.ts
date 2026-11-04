/**
 * A user's Figma REST token for imports (Story 8.3). Per user, per workspace, encrypted at rest with
 * @crunch/crypto; the AAD binds the ciphertext to both the workspace and the user, so a row copied
 * to another user or workspace fails to decrypt. Only `loadFigmaToken` returns plaintext, and only
 * for server-side REST calls; nothing derived from the token is ever sent to the browser.
 */
import { assertCan } from '@crunch/authz';
import { decryptSecret, encryptSecret, type Keyring } from '@crunch/crypto';
import { and, eq, figmaCredentials, type Db } from '@crunch/db';
import { z } from 'zod';
import { NotFoundError, ValidationError, type Actor } from '../types';
import { FigmaRest, type FigmaFetch } from './rest';

export const aadForFigma = (workspaceId: string, userId: string) =>
  `figma_credential:${workspaceId}:${userId}`;

const tokenSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{20,200}$/, 'That doesn’t look like a Figma personal access token');

export interface PublicFigmaCredential {
  hint: string;
  figmaUserHandle: string | null;
  createdAt: string;
}

export interface FigmaCredentialDeps {
  keyring?: Keyring;
  fetch?: FigmaFetch;
}

const scope = (actor: Actor) =>
  and(
    eq(figmaCredentials.workspaceId, actor.workspace.id),
    eq(figmaCredentials.userId, actor.userId),
  );

export async function getFigmaCredential(
  db: Db,
  actor: Actor,
): Promise<PublicFigmaCredential | null> {
  assertCan(actor.role, 'workspace:read');
  const [row] = await db.select().from(figmaCredentials).where(scope(actor)).limit(1);
  return row
    ? {
        hint: row.hint,
        figmaUserHandle: row.figmaUserHandle,
        createdAt: row.createdAt.toISOString(),
      }
    : null;
}

/** Verify the token with Figma (GET /v1/me), then store it encrypted. */
export async function saveFigmaToken(
  db: Db,
  actor: Actor,
  rawToken: unknown,
  deps: FigmaCredentialDeps = {},
): Promise<PublicFigmaCredential> {
  assertCan(actor.role, 'design:edit');
  const parsed = tokenSchema.safeParse(rawToken);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? 'Invalid token';
    throw new ValidationError(msg, { token: [msg] });
  }
  const token = parsed.data;
  const me = await new FigmaRest(token, deps.fetch).me();
  const values = {
    tokenEnvelope: encryptSecret(
      token,
      aadForFigma(actor.workspace.id, actor.userId),
      deps.keyring,
    ),
    hint: `…${token.slice(-4)}`,
    figmaUserHandle: me.handle?.slice(0, 100) ?? null,
  };
  const [row] = await db
    .insert(figmaCredentials)
    .values({ workspaceId: actor.workspace.id, userId: actor.userId, ...values })
    .onConflictDoUpdate({
      target: [figmaCredentials.workspaceId, figmaCredentials.userId],
      set: values,
    })
    .returning();
  return {
    hint: row!.hint,
    figmaUserHandle: row!.figmaUserHandle,
    createdAt: row!.createdAt.toISOString(),
  };
}

export async function deleteFigmaToken(db: Db, actor: Actor): Promise<void> {
  assertCan(actor.role, 'workspace:read');
  await db.delete(figmaCredentials).where(scope(actor));
}

/** SERVER-ONLY: the caller's decrypted Figma token, for REST calls. */
export async function loadFigmaToken(db: Db, actor: Actor, keyring?: Keyring): Promise<string> {
  const [row] = await db.select().from(figmaCredentials).where(scope(actor)).limit(1);
  if (!row) throw new NotFoundError('Add your Figma token in Settings → Figma first');
  return decryptSecret(row.tokenEnvelope, aadForFigma(actor.workspace.id, actor.userId), keyring);
}
