/**
 * Soft edit lock and presence (Story 3.8, SPEC D3).
 *
 * - One lock per project (edit_locks). It's live while its heartbeat is newer than
 *   EDIT_LOCK_TTL_MS (2 minutes), so a lock expires 2 minutes after the holder's tab dies.
 *   Writes from anyone else are rejected by design-docs (`assertNotLockedByOther`).
 * - Acquiring is a single atomic upsert that only wins if the lock is free, expired, or already
 *   held by the same user (a second tab of the same user takes it over).
 * - Presence: every open editor tab (viewers too) heartbeats a presence row; rows older than
 *   PRESENCE_TTL_MS drop out of the avatar list.
 * - "Request control" records the request on the lock and notifies the holder, who can hand over
 *   (the lock moves to the requester) or decline. Admins can take over.
 */
import { assertCan } from '@crunch/authz';
import {
  and,
  editLocks,
  eq,
  gt,
  inArray,
  notifications,
  presence,
  sql,
  users,
  type Db,
} from '@crunch/db';
import { EDIT_LOCK_TTL_MS } from './design-docs';
import { getProject } from './projects';
import { ValidationError, type Actor } from './types';

export const HEARTBEAT_MS = 20_000;
export const PRESENCE_TTL_MS = 45_000;

export interface Person {
  userId: string;
  name: string | null;
  imageUrl: string | null;
}

export interface LockState {
  lock: null | {
    holder: Person;
    isMine: boolean;
    /** The holder's lock is held by this very tab. */
    isThisSession: boolean;
    acquiredAt: string;
    heartbeatAt: string;
    requestedBy: Person | null;
  };
  /** Members with the project open, most recent first (one entry per user). */
  presence: (Person & { isMe: boolean })[];
  /** The caller may take over a lock held by someone else. */
  canTakeOver: boolean;
  ttlMs: number;
}

const SESSION_RE = /^[\w-]{8,64}$/;
function checkSession(sessionId: unknown): string {
  if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId))
    throw new ValidationError('Invalid session id');
  return sessionId;
}

const cutoff = () => new Date(Date.now() - EDIT_LOCK_TTL_MS);

async function people(db: Db, ids: string[]): Promise<Map<string, Person>> {
  const unique = [...new Set(ids)];
  const rows = unique.length
    ? await db
        .select({ id: users.id, name: users.name, imageUrl: users.imageUrl })
        .from(users)
        .where(inArray(users.id, unique))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return new Map(
    unique.map((id) => [
      id,
      { userId: id, name: byId.get(id)?.name ?? null, imageUrl: byId.get(id)?.imageUrl ?? null },
    ]),
  );
}

async function touchPresence(db: Db, actor: Actor, projectId: string, sessionId: string) {
  await db
    .insert(presence)
    .values({ projectId, userId: actor.userId, sessionId, lastSeenAt: new Date() })
    .onConflictDoUpdate({
      target: [presence.projectId, presence.sessionId],
      set: { lastSeenAt: new Date(), userId: actor.userId },
    });
}

async function readState(
  db: Db,
  actor: Actor,
  projectId: string,
  sessionId?: string,
): Promise<LockState> {
  const [lock] = await db
    .select()
    .from(editLocks)
    .where(and(eq(editLocks.projectId, projectId), gt(editLocks.heartbeatAt, cutoff())))
    .limit(1);
  const seen = await db
    .select({ userId: presence.userId, lastSeenAt: presence.lastSeenAt })
    .from(presence)
    .where(
      and(
        eq(presence.projectId, projectId),
        gt(presence.lastSeenAt, new Date(Date.now() - PRESENCE_TTL_MS)),
      ),
    )
    .orderBy(sql`${presence.lastSeenAt} desc`);
  const viewerIds = [...new Set(seen.map((s) => s.userId))];
  const who = await people(db, [
    ...viewerIds,
    ...(lock ? [lock.holderUserId] : []),
    ...(lock?.requestedBy ? [lock.requestedBy] : []),
  ]);
  return {
    lock: lock
      ? {
          holder: who.get(lock.holderUserId)!,
          isMine: lock.holderUserId === actor.userId,
          isThisSession: lock.holderUserId === actor.userId && lock.sessionId === sessionId,
          acquiredAt: lock.acquiredAt.toISOString(),
          heartbeatAt: lock.heartbeatAt.toISOString(),
          requestedBy: lock.requestedBy ? who.get(lock.requestedBy)! : null,
        }
      : null,
    presence: viewerIds.map((id) => ({ ...who.get(id)!, isMe: id === actor.userId })),
    canTakeOver: actor.role === 'admin' && !!lock && lock.holderUserId !== actor.userId,
    ttlMs: EDIT_LOCK_TTL_MS,
  };
}

export async function getLockState(
  db: Db,
  actor: Actor,
  projectId: string,
  sessionId?: string,
): Promise<LockState> {
  assertCan(actor.role, 'project:read');
  await getProject(db, actor, projectId);
  return readState(db, actor, projectId, sessionId);
}

/** Take the lock if it's free, expired, or already ours. Never steals a live lock. */
export async function acquireLock(
  db: Db,
  actor: Actor,
  projectId: string,
  input: { sessionId: unknown },
): Promise<{ acquired: boolean; state: LockState }> {
  assertCan(actor.role, 'design:edit');
  const sessionId = checkSession(input.sessionId);
  await getProject(db, actor, projectId);
  const now = new Date();
  const won = await db
    .insert(editLocks)
    .values({
      projectId,
      workspaceId: actor.workspace.id,
      holderUserId: actor.userId,
      sessionId,
      acquiredAt: now,
      heartbeatAt: now,
    })
    .onConflictDoUpdate({
      target: editLocks.projectId,
      set: {
        holderUserId: actor.userId,
        sessionId,
        heartbeatAt: now,
        // Same holder (another tab or a re-acquire) keeps its start time and pending request.
        acquiredAt: sql`case when ${editLocks.holderUserId} = ${actor.userId} then ${editLocks.acquiredAt} else ${now} end`,
        requestedBy: sql`case when ${editLocks.holderUserId} = ${actor.userId} then ${editLocks.requestedBy} else null end`,
        requestedAt: sql`case when ${editLocks.holderUserId} = ${actor.userId} then ${editLocks.requestedAt} else null end`,
      },
      setWhere: sql`${editLocks.holderUserId} = ${actor.userId} or ${editLocks.heartbeatAt} <= ${cutoff()}`,
    })
    .returning({ holder: editLocks.holderUserId });
  await touchPresence(db, actor, projectId, sessionId);
  return { acquired: won.length > 0, state: await readState(db, actor, projectId, sessionId) };
}

/** Keep presence (everyone) and the lock (its holder) alive. */
export async function heartbeat(
  db: Db,
  actor: Actor,
  projectId: string,
  input: { sessionId: unknown },
): Promise<LockState> {
  assertCan(actor.role, 'project:read');
  const sessionId = checkSession(input.sessionId);
  await getProject(db, actor, projectId);
  await touchPresence(db, actor, projectId, sessionId);
  if (actor.role !== 'viewer') {
    await db
      .update(editLocks)
      .set({ heartbeatAt: new Date(), sessionId })
      .where(
        and(
          eq(editLocks.projectId, projectId),
          eq(editLocks.holderUserId, actor.userId),
          gt(editLocks.heartbeatAt, cutoff()),
        ),
      );
  }
  return readState(db, actor, projectId, sessionId);
}

/**
 * Release the lock if the caller holds it. With `handoff`, the lock passes to whoever requested
 * control (their next heartbeat adopts it). `leave` also removes this tab's presence.
 */
export async function releaseLock(
  db: Db,
  actor: Actor,
  projectId: string,
  input: { sessionId: unknown; handoff?: boolean; leave?: boolean },
): Promise<LockState> {
  assertCan(actor.role, 'project:read');
  const sessionId = checkSession(input.sessionId);
  await getProject(db, actor, projectId);
  if (input.leave) {
    await db
      .delete(presence)
      .where(and(eq(presence.projectId, projectId), eq(presence.sessionId, sessionId)));
  }
  const mine = and(eq(editLocks.projectId, projectId), eq(editLocks.holderUserId, actor.userId));
  if (input.handoff) {
    const [lock] = await db.select().from(editLocks).where(mine).limit(1);
    if (lock?.requestedBy) {
      const now = new Date();
      await db
        .update(editLocks)
        .set({
          holderUserId: lock.requestedBy,
          sessionId: `handoff-${now.getTime()}`,
          acquiredAt: now,
          heartbeatAt: now,
          requestedBy: null,
          requestedAt: null,
        })
        .where(mine);
      await db.insert(notifications).values({
        workspaceId: actor.workspace.id,
        userId: lock.requestedBy,
        kind: 'control_granted',
        projectId,
        data: { from: actor.userId },
      });
      return readState(db, actor, projectId, sessionId);
    }
  }
  // Only the tab that holds the lock releases it on close (other tabs of the same user keep it).
  await db
    .delete(editLocks)
    .where(input.leave ? and(mine, eq(editLocks.sessionId, sessionId)) : mine);
  return readState(db, actor, projectId, sessionId);
}

/** Ask the holder for control. Notifies them in-app; idempotent while a request is pending. */
export async function requestControl(
  db: Db,
  actor: Actor,
  projectId: string,
  input: { sessionId: unknown },
): Promise<LockState> {
  assertCan(actor.role, 'design:edit');
  const sessionId = checkSession(input.sessionId);
  await getProject(db, actor, projectId);
  const [lock] = await db
    .update(editLocks)
    .set({ requestedBy: actor.userId, requestedAt: new Date() })
    .where(
      and(
        eq(editLocks.projectId, projectId),
        gt(editLocks.heartbeatAt, cutoff()),
        sql`${editLocks.holderUserId} <> ${actor.userId}`,
        sql`${editLocks.requestedBy} is distinct from ${actor.userId}`,
      ),
    )
    .returning({ holder: editLocks.holderUserId });
  if (lock) {
    await db.insert(notifications).values({
      workspaceId: actor.workspace.id,
      userId: lock.holder,
      kind: 'control_request',
      projectId,
      data: { requestedBy: actor.userId },
    });
  }
  return readState(db, actor, projectId, sessionId);
}

/** The holder declines a pending request. */
export async function declineRequest(
  db: Db,
  actor: Actor,
  projectId: string,
  input: { sessionId: unknown },
): Promise<LockState> {
  assertCan(actor.role, 'design:edit');
  const sessionId = checkSession(input.sessionId);
  await getProject(db, actor, projectId);
  await db
    .update(editLocks)
    .set({ requestedBy: null, requestedAt: null })
    .where(and(eq(editLocks.projectId, projectId), eq(editLocks.holderUserId, actor.userId)));
  return readState(db, actor, projectId, sessionId);
}

/** Admins take the lock from whoever holds it. The previous holder is notified. */
export async function takeOver(
  db: Db,
  actor: Actor,
  projectId: string,
  input: { sessionId: unknown },
): Promise<LockState> {
  assertCan(actor.role, 'design:edit');
  // Taking over is admin-only (SPEC 3.8). authz has no dedicated permission yet, so this uses the
  // admin-only workspace:manage_members (requested as `design:take_over` for integration).
  assertCan(actor.role, 'workspace:manage_members');
  const sessionId = checkSession(input.sessionId);
  await getProject(db, actor, projectId);
  const [prev] = await db
    .select({ holder: editLocks.holderUserId })
    .from(editLocks)
    .where(and(eq(editLocks.projectId, projectId), gt(editLocks.heartbeatAt, cutoff())))
    .limit(1);
  const now = new Date();
  await db
    .insert(editLocks)
    .values({
      projectId,
      workspaceId: actor.workspace.id,
      holderUserId: actor.userId,
      sessionId,
      acquiredAt: now,
      heartbeatAt: now,
    })
    .onConflictDoUpdate({
      target: editLocks.projectId,
      set: {
        holderUserId: actor.userId,
        sessionId,
        acquiredAt: now,
        heartbeatAt: now,
        requestedBy: null,
        requestedAt: null,
      },
    });
  if (prev && prev.holder !== actor.userId) {
    await db.insert(notifications).values({
      workspaceId: actor.workspace.id,
      userId: prev.holder,
      kind: 'control_taken',
      projectId,
      data: { by: actor.userId },
    });
  }
  await touchPresence(db, actor, projectId, sessionId);
  return readState(db, actor, projectId, sessionId);
}
