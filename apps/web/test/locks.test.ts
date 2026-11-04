import { ForbiddenError } from '@crunch/authz';
import { and, editLocks, eq, notifications, presence } from '@crunch/db';
import { newId } from '@crunch/doc-model';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { commitTransaction, getDoc, LockedError } from '@/server/services/design-docs';
import {
  acquireLock,
  declineRequest,
  getLockState,
  heartbeat,
  releaseLock,
  requestControl,
  takeOver,
} from '@/server/services/locks';
import { createProject } from '@/server/services/projects';
import { NotFoundError, ValidationError } from '@/server/services/types';
import { makeActor, reset, testDb } from './helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

const S1 = 'session-aaaa-1111';
const S2 = 'session-bbbb-2222';
const S3 = 'session-cccc-3333';

async function setup() {
  const alice = await makeActor(db, 'editor');
  const bob = await makeActor(db, 'editor', alice.workspace);
  const admin = await makeActor(db, 'admin', alice.workspace);
  const viewer = await makeActor(db, 'viewer', alice.workspace);
  const project = await createProject(db, alice, { name: 'P' });
  return { alice, bob, admin, viewer, project };
}

/** Age the lock's heartbeat past the 2-minute TTL, as if the holder's tab died. */
async function expire(projectId: string) {
  await db
    .update(editLocks)
    .set({ heartbeatAt: new Date(Date.now() - 2 * 60 * 1000 - 1000) })
    .where(eq(editLocks.projectId, projectId));
}

describe('edit lock (Story 3.8)', () => {
  it('the first editor gets the lock; others are refused and read-only on the server', async () => {
    const { alice, bob, project } = await setup();
    const a = await acquireLock(db, alice, project.id, { sessionId: S1 });
    expect(a.acquired).toBe(true);
    expect(a.state.lock).toMatchObject({ isMine: true, isThisSession: true });

    const b = await acquireLock(db, bob, project.id, { sessionId: S2 });
    expect(b.acquired).toBe(false);
    expect(b.state.lock).toMatchObject({ isMine: false, holder: { userId: alice.userId } });

    // design-docs enforces the lock on writes
    const { doc } = await getDoc(db, bob, project.id);
    const rootId = doc.frames[0]!.rootNodeId;
    await expect(
      commitTransaction(db, bob, project.id, {
        baseVersion: 0,
        txn: {
          id: `t_${newId('s').slice(2)}`,
          source: 'canvas',
          ops: [{ op: 'setNodeMeta', id: rootId, patch: { name: 'X' } }],
        },
      }),
    ).rejects.toBeInstanceOf(LockedError);
  });

  it('a lock expires 2 minutes after the last heartbeat; heartbeats keep it alive', async () => {
    const { alice, bob, project } = await setup();
    await acquireLock(db, alice, project.id, { sessionId: S1 });
    await heartbeat(db, alice, project.id, { sessionId: S1 });
    expect((await acquireLock(db, bob, project.id, { sessionId: S2 })).acquired).toBe(false);
    await expire(project.id);
    // an expired lock reads as free
    expect((await getLockState(db, bob, project.id)).lock).toBeNull();
    // and a heartbeat from the dead holder can't revive it
    await heartbeat(db, alice, project.id, { sessionId: S1 });
    expect((await getLockState(db, bob, project.id)).lock).toBeNull();
    const b = await acquireLock(db, bob, project.id, { sessionId: S2 });
    expect(b.acquired).toBe(true);
    expect(b.state.lock?.holder.userId).toBe(bob.userId);
  });

  it('the same user in another tab takes the lock over, keeping its start time', async () => {
    const { alice, project } = await setup();
    const first = await acquireLock(db, alice, project.id, { sessionId: S1 });
    const second = await acquireLock(db, alice, project.id, { sessionId: S3 });
    expect(second.acquired).toBe(true);
    expect(second.state.lock?.acquiredAt).toBe(first.state.lock?.acquiredAt);
    expect(second.state.lock?.isThisSession).toBe(true);
  });

  it('releasing frees the lock; closing a non-holding tab does not', async () => {
    const { alice, bob, project } = await setup();
    await acquireLock(db, alice, project.id, { sessionId: S1 });
    await releaseLock(db, alice, project.id, { sessionId: S3, leave: true }); // other tab closes
    expect((await getLockState(db, bob, project.id)).lock?.holder.userId).toBe(alice.userId);
    await releaseLock(db, bob, project.id, { sessionId: S2 }); // not the holder: no effect
    expect((await getLockState(db, bob, project.id)).lock).not.toBeNull();
    await releaseLock(db, alice, project.id, { sessionId: S1, leave: true });
    expect((await getLockState(db, bob, project.id)).lock).toBeNull();
  });

  it('request control notifies the holder; the holder can decline or hand over', async () => {
    const { alice, bob, project } = await setup();
    await acquireLock(db, alice, project.id, { sessionId: S1 });
    const r = await requestControl(db, bob, project.id, { sessionId: S2 });
    expect(r.lock?.requestedBy?.userId).toBe(bob.userId);
    await requestControl(db, bob, project.id, { sessionId: S2 }); // idempotent
    const notes = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.userId, alice.userId), eq(notifications.kind, 'control_request')),
      );
    expect(notes).toHaveLength(1);
    expect(notes[0]!.data).toEqual({ requestedBy: bob.userId });

    // holder sees the request on its heartbeat, declines
    expect(
      (await heartbeat(db, alice, project.id, { sessionId: S1 })).lock?.requestedBy?.userId,
    ).toBe(bob.userId);
    await declineRequest(db, alice, project.id, { sessionId: S1 });
    expect((await getLockState(db, alice, project.id)).lock?.requestedBy).toBeNull();

    // ask again; this time hand over
    await requestControl(db, bob, project.id, { sessionId: S2 });
    await releaseLock(db, alice, project.id, { sessionId: S1, handoff: true });
    const s = await heartbeat(db, bob, project.id, { sessionId: S2 });
    expect(s.lock).toMatchObject({ isMine: true, isThisSession: true, requestedBy: null });
  });

  it('admins can take over; editors cannot', async () => {
    const { alice, bob, admin, project } = await setup();
    await acquireLock(db, alice, project.id, { sessionId: S1 });
    await expect(takeOver(db, bob, project.id, { sessionId: S2 })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect((await getLockState(db, admin, project.id)).canTakeOver).toBe(true);
    const s = await takeOver(db, admin, project.id, { sessionId: S3 });
    expect(s.lock).toMatchObject({ isMine: true, holder: { userId: admin.userId } });
    const [note] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.kind, 'control_taken'));
    expect(note).toMatchObject({ userId: alice.userId });
    // alice's heartbeat no longer extends the lock, and she now sees it held by the admin
    const a = await heartbeat(db, alice, project.id, { sessionId: S1 });
    expect(a.lock).toMatchObject({ isMine: false, holder: { userId: admin.userId } });
  });

  it('viewers show up in presence but can never hold or request the lock', async () => {
    const { alice, viewer, project } = await setup();
    await acquireLock(db, alice, project.id, { sessionId: S1 });
    const s = await heartbeat(db, viewer, project.id, { sessionId: S2 });
    expect(s.presence.map((p) => p.userId).sort()).toEqual([alice.userId, viewer.userId].sort());
    expect(s.presence.find((p) => p.isMe)?.userId).toBe(viewer.userId);
    await expect(acquireLock(db, viewer, project.id, { sessionId: S2 })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(requestControl(db, viewer, project.id, { sessionId: S2 })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('stale presence drops out, and leaving removes the tab', async () => {
    const { alice, bob, project } = await setup();
    await heartbeat(db, alice, project.id, { sessionId: S1 });
    await heartbeat(db, bob, project.id, { sessionId: S2 });
    await db
      .update(presence)
      .set({ lastSeenAt: new Date(Date.now() - 60_000) })
      .where(eq(presence.sessionId, S2));
    expect((await getLockState(db, alice, project.id)).presence.map((p) => p.userId)).toEqual([
      alice.userId,
    ]);
    await releaseLock(db, alice, project.id, { sessionId: S1, leave: true });
    expect((await getLockState(db, alice, project.id)).presence).toEqual([]);
  });

  it('is scoped to the workspace and validates session ids', async () => {
    const { project } = await setup();
    const outsider = await makeActor(db, 'admin');
    await expect(acquireLock(db, outsider, project.id, { sessionId: S1 })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(getLockState(db, outsider, project.id)).rejects.toBeInstanceOf(NotFoundError);
    const { alice } = await setup();
    await expect(acquireLock(db, alice, project.id, { sessionId: 'x' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
