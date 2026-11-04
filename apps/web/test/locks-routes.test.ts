/**
 * Lock route handlers (Story 3.8): auth, validation, role checks and workspace scoping on every
 * route, against the real services and test database. Clerk is replaced by a settable actor.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Actor } from '@/server/services/types';

const h = vi.hoisted(() => ({ actor: null as Actor | null, db: null as unknown }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/context', () => ({ getActor: async () => h.actor, db: () => h.db }));
vi.mock('@crunch/db', async (orig) => ({
  ...(await orig<typeof import('@crunch/db')>()),
  getDb: () => h.db,
}));

const { makeActor, reset, testDb } = await import('./helpers');
const { createProject } = await import('@/server/services/projects');
const { upsertMember } = await import('@/server/services/workspaces');
const lock = await import('@/app/api/projects/[projectId]/lock/route');
const request = await import('@/app/api/projects/[projectId]/lock/request/route');
const takeover = await import('@/app/api/projects/[projectId]/lock/takeover/route');

const { db, close } = testDb();
h.db = db;
afterAll(close);
beforeEach(() => reset(db));

const S1 = 'session-aaaa-1111';
const S2 = 'session-bbbb-2222';
type Ctx = { params: Promise<{ projectId: string }> };
const ctx = (projectId: string): Ctx => ({ params: Promise.resolve({ projectId }) });
const req = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
  new NextRequest(new URL(url, 'http://localhost'), init);
const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function setup() {
  const alice = await makeActor(db, 'editor');
  const bob = await makeActor(db, 'editor', alice.workspace);
  const admin = await makeActor(db, 'admin', alice.workspace);
  for (const a of [alice, bob, admin]) await upsertMember(db, a.workspace.id, a.userId, a.role);
  const project = await createProject(db, alice, { name: 'P' });
  const outsider = await makeActor(db, 'admin'); // another workspace
  return { alice, bob, admin, outsider, project };
}

/** Every lock route, called as the current actor. */
const calls = (pid: string) => ({
  get: () => lock.GET(req(`/api/projects/${pid}/lock?sessionId=${S1}`), ctx(pid)),
  acquire: () => lock.POST(req(`/x`, json({ sessionId: S1 })), ctx(pid)),
  heartbeat: () => lock.PUT(req(`/x`, json({ sessionId: S1 }, 'PUT')), ctx(pid)),
  release: () => lock.DELETE(req(`/x?sessionId=${S1}&leave=1`, { method: 'DELETE' }), ctx(pid)),
  request: () => request.POST(req(`/x`, json({ sessionId: S1 })), ctx(pid)),
  decline: () => request.DELETE(req(`/x?sessionId=${S1}`, { method: 'DELETE' }), ctx(pid)),
  takeover: () => takeover.POST(req(`/x`, json({ sessionId: S1 })), ctx(pid)),
});

describe('lock routes', () => {
  it('reject signed-out callers on every route', async () => {
    const { project } = await setup();
    h.actor = null;
    for (const [name, call] of Object.entries(calls(project.id)))
      expect((await call()).status, name).toBe(401);
  });

  it('report another workspace’s project as not found on every route', async () => {
    const { project, outsider } = await setup();
    h.actor = outsider;
    for (const [name, call] of Object.entries(calls(project.id)))
      expect((await call()).status, name).toBe(404);
  });

  it('acquire, heartbeat, request, take over and release through HTTP', async () => {
    const { alice, bob, admin, project } = await setup();
    h.actor = alice;
    const a = await (await calls(project.id).acquire()).json();
    expect(a).toMatchObject({ acquired: true, state: { lock: { isMine: true } } });
    expect((await calls(project.id).heartbeat()).status).toBe(200);

    h.actor = bob;
    const b = await lock.POST(req('/x', json({ sessionId: S2 })), ctx(project.id));
    expect(await b.json()).toMatchObject({ acquired: false });
    const r = await request.POST(req('/x', json({ sessionId: S2 })), ctx(project.id));
    expect((await r.json()).lock.requestedBy.userId).toBe(bob.userId);
    // editors can't take over
    expect((await takeover.POST(req('/x', json({ sessionId: S2 })), ctx(project.id))).status).toBe(
      403,
    );

    h.actor = admin;
    const t = await (await calls(project.id).takeover()).json();
    expect(t.lock).toMatchObject({ isMine: true, holder: { userId: admin.userId } });
    expect((await calls(project.id).release()).status).toBe(200);
    expect((await (await calls(project.id).get()).json()).lock).toBeNull();
  });

  it('validate bodies and session ids', async () => {
    const { alice, project } = await setup();
    h.actor = alice;
    expect((await lock.POST(req('/x', json({})), ctx(project.id))).status).toBe(400);
    expect((await lock.POST(req('/x', json({ sessionId: 'x' })), ctx(project.id))).status).toBe(
      400,
    );
    expect(
      (await lock.POST(req('/x', json({ sessionId: S1, extra: 1 })), ctx(project.id))).status,
    ).toBe(400);
  });
});
