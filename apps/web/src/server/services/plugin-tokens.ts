/**
 * Figma plugin tokens (Story 8.1).
 *
 * - A token is `cdp_` + 43 base64url chars (32 random bytes). It's shown exactly once, at creation.
 * - Only its SHA-256 hash is stored (plus the last 4 characters, for display). The hash is
 *   unique-indexed, so authentication is a single indexed lookup.
 * - A token belongs to one user in one workspace. Every request re-reads the member's role from
 *   the `members` table, so demoting or removing a member takes effect immediately.
 * - Tokens are revocable by their owner, or by a workspace Admin.
 */
import { assertCan, can, ROLES, type Role } from '@crunch/authz';
import {
  and,
  desc,
  eq,
  isNull,
  members,
  pluginTokens,
  workspaces,
  type Db,
  type PluginTokenRow,
} from '@crunch/db';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { NotFoundError, ValidationError, type Actor } from './types';

export const PLUGIN_TOKEN_PREFIX = 'cdp_';
/** A user can hold at most this many live tokens per workspace. */
export const MAX_TOKENS_PER_USER = 20;
/** Don't rewrite last_used_at more often than this. */
const TOUCH_INTERVAL_MS = 60_000;

const TOKEN_RE = /^cdp_[A-Za-z0-9_-]{43}$/;

export interface PublicPluginToken {
  id: string;
  name: string;
  /** e.g. "cdp_…AbCd" */
  hint: string;
  userId: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export class InvalidTokenError extends Error {
  override name = 'InvalidTokenError';
  constructor() {
    super('Invalid or revoked plugin token');
  }
}

export function hashPluginToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function generateToken(): string {
  return PLUGIN_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

function toPublic(row: PluginTokenRow): PublicPluginToken {
  return {
    id: row.id,
    name: row.name,
    hint: `${PLUGIN_TOKEN_PREFIX}…${row.last4}`,
    userId: row.userId,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

const nameSchema = z.string().trim().min(1, 'Name is required').max(60, 'Name is too long');

/** Create a token for the calling user. The plaintext is returned once and never stored. */
export async function createPluginToken(
  db: Db,
  actor: Actor,
  input: { name: unknown },
): Promise<{ token: string; record: PublicPluginToken }> {
  assertCan(actor.role, 'workspace:read');
  const parsed = nameSchema.safeParse(input.name);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? 'Invalid name';
    throw new ValidationError(msg, { name: [msg] });
  }
  const live = await db
    .select({ id: pluginTokens.id })
    .from(pluginTokens)
    .where(
      and(
        eq(pluginTokens.workspaceId, actor.workspace.id),
        eq(pluginTokens.userId, actor.userId),
        isNull(pluginTokens.revokedAt),
      ),
    );
  if (live.length >= MAX_TOKENS_PER_USER) {
    throw new ValidationError(`You can have at most ${MAX_TOKENS_PER_USER} active tokens`);
  }
  const token = generateToken();
  const [row] = await db
    .insert(pluginTokens)
    .values({
      workspaceId: actor.workspace.id,
      userId: actor.userId,
      name: parsed.data,
      tokenHash: hashPluginToken(token),
      last4: token.slice(-4),
    })
    .returning();
  return { token, record: toPublic(row!) };
}

/** The caller's tokens; Admins see every member's tokens in the workspace. */
export async function listPluginTokens(
  db: Db,
  actor: Actor,
  opts: { includeRevoked?: boolean } = {},
): Promise<PublicPluginToken[]> {
  assertCan(actor.role, 'workspace:read');
  const all = can(actor.role, 'workspace:manage_members');
  const rows = await db
    .select()
    .from(pluginTokens)
    .where(
      and(
        eq(pluginTokens.workspaceId, actor.workspace.id),
        all ? undefined : eq(pluginTokens.userId, actor.userId),
        opts.includeRevoked ? undefined : isNull(pluginTokens.revokedAt),
      ),
    )
    .orderBy(desc(pluginTokens.createdAt));
  return rows.map(toPublic);
}

/** Revoke a token. Owners revoke their own; Admins can revoke anyone's in their workspace. */
export async function revokePluginToken(db: Db, actor: Actor, tokenId: string): Promise<void> {
  assertCan(actor.role, 'workspace:read');
  if (!z.uuid().safeParse(tokenId).success) throw new NotFoundError('Token not found');
  const [row] = await db
    .select()
    .from(pluginTokens)
    .where(and(eq(pluginTokens.id, tokenId), eq(pluginTokens.workspaceId, actor.workspace.id)))
    .limit(1);
  if (!row) throw new NotFoundError('Token not found');
  if (row.userId !== actor.userId) {
    // Other members' tokens are invisible to non-admins: report them as not found.
    if (!can(actor.role, 'workspace:manage_members')) throw new NotFoundError('Token not found');
  }
  if (row.revokedAt) return;
  await db.update(pluginTokens).set({ revokedAt: new Date() }).where(eq(pluginTokens.id, tokenId));
}

/** Extract a bearer token from an Authorization header value. */
export function bearerFrom(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1]! : null;
}

export interface PluginActor extends Actor {
  tokenId: string;
}

/** Membership as Clerk (the source of truth) sees it right now. Throws if Clerk is unreachable. */
export type MembershipVerifier = (
  clerkOrgId: string,
  userId: string,
) => Promise<{ member: false } | { member: true; role: Role }>;

/** Re-check membership with Clerk when the last check is older than this. */
export const MEMBERSHIP_RECHECK_MS = 10 * 60 * 1000;
/** If Clerk is unreachable, keep honouring a successful check this old, then fail closed. */
export const MEMBERSHIP_GRACE_MS = 30 * 60 * 1000;

export class MembershipUnavailableError extends Error {
  override name = 'MembershipUnavailableError';
  constructor() {
    super('Could not verify workspace membership; try again shortly');
  }
}

/** tokenId -> last successful Clerk verification (per server instance). */
const verifiedAt = new Map<string, number>();
const MAX_VERIFIED_ENTRIES = 10_000;

/** For tests: forget cached verifications. */
export function resetMembershipCache() {
  verifiedAt.clear();
}

/** Default verifier: Clerk's backend API (loaded lazily so services stay framework-free). */
export const clerkMembershipVerifier: MembershipVerifier = async (clerkOrgId, userId) => {
  const { clerkClient } = await import('@clerk/nextjs/server');
  const { roleFromClerk } = await import('@crunch/authz');
  const client = await clerkClient();
  let list;
  try {
    list = await client.organizations.getOrganizationMembershipList({
      organizationId: clerkOrgId,
      userId: [userId],
      limit: 1,
    });
  } catch (e) {
    // The organization no longer exists: nobody is a member. Anything else is "unreachable".
    if ((e as { status?: number }).status === 404) return { member: false };
    console.error(
      '[plugin-tokens] Clerk membership check failed',
      e instanceof Error ? e.name : typeof e,
    );
    throw e;
  }
  const m = list.data.find((x) => x.publicUserData?.userId === userId);
  return m ? { member: true, role: roleFromClerk(m.role) } : { member: false };
};

export interface AuthenticateOptions {
  now?: Date;
  verify?: MembershipVerifier;
}

/**
 * Resolve a plugin token to an actor. Throws InvalidTokenError for anything that isn't a live
 * token of a current member of a live workspace (all reported the same way, to avoid oracles).
 *
 * The `members` mirror only changes on Clerk webhooks or the user's own sign-in, so membership
 * is re-verified against Clerk every MEMBERSHIP_RECHECK_MS: a removed member's token is revoked,
 * a role change updates the mirror, and if Clerk is unreachable past the grace period, requests
 * fail closed (MembershipUnavailableError).
 */
export async function authenticatePluginToken(
  db: Db,
  token: string | null,
  opts: AuthenticateOptions = {},
): Promise<PluginActor> {
  const now = opts.now ?? new Date();
  const verify = opts.verify ?? clerkMembershipVerifier;
  if (!token || !TOKEN_RE.test(token)) throw new InvalidTokenError();
  const [hit] = await db
    .select({ token: pluginTokens, workspace: workspaces, role: members.role })
    .from(pluginTokens)
    .innerJoin(workspaces, eq(workspaces.id, pluginTokens.workspaceId))
    .innerJoin(
      members,
      and(
        eq(members.workspaceId, pluginTokens.workspaceId),
        eq(members.userId, pluginTokens.userId),
      ),
    )
    .where(eq(pluginTokens.tokenHash, hashPluginToken(token)))
    .limit(1);
  if (!hit || hit.token.revokedAt || hit.workspace.deletedAt) throw new InvalidTokenError();
  let role = hit.role as Role;
  if (!ROLES.includes(role)) throw new InvalidTokenError();

  const last = verifiedAt.get(hit.token.id) ?? 0;
  if (now.getTime() - last > MEMBERSHIP_RECHECK_MS) {
    let result: Awaited<ReturnType<MembershipVerifier>> | null = null;
    try {
      result = await verify(hit.workspace.clerkOrgId, hit.token.userId);
    } catch {
      if (now.getTime() - last > MEMBERSHIP_GRACE_MS) throw new MembershipUnavailableError();
    }
    if (result && !result.member) {
      // Clerk says they're gone: revoke the token and correct the mirror.
      await db
        .update(pluginTokens)
        .set({ revokedAt: now })
        .where(eq(pluginTokens.id, hit.token.id));
      await db
        .delete(members)
        .where(
          and(eq(members.workspaceId, hit.workspace.id), eq(members.userId, hit.token.userId)),
        );
      verifiedAt.delete(hit.token.id);
      throw new InvalidTokenError();
    }
    if (result?.member) {
      if (result.role !== role) {
        await db
          .update(members)
          .set({ role: result.role })
          .where(
            and(eq(members.workspaceId, hit.workspace.id), eq(members.userId, hit.token.userId)),
          );
        role = result.role;
      }
      if (verifiedAt.size >= MAX_VERIFIED_ENTRIES) verifiedAt.clear();
      verifiedAt.set(hit.token.id, now.getTime());
    }
  }

  const lastUsed = hit.token.lastUsedAt?.getTime() ?? 0;
  if (now.getTime() - lastUsed > TOUCH_INTERVAL_MS) {
    await db.update(pluginTokens).set({ lastUsedAt: now }).where(eq(pluginTokens.id, hit.token.id));
  }
  return { userId: hit.token.userId, role, workspace: hit.workspace, tokenId: hit.token.id };
}
