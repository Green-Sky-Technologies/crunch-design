/**
 * Plugin API plumbing: bearer auth (no Clerk), role enforcement, CORS for the plugin's null
 * origin, rate limiting, body limits, and the project/frame listing the plugin shows (Story 8.1).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assertCan } from '@crunch/authz';
import { createProject } from '@/server/services/projects';
import { listFramesForPlugin, listProjectsForPlugin } from '@/server/services/figma';
import {
  PLUGIN_RATE_LIMIT,
  pluginBody,
  pluginPreflight,
  pluginRoute,
} from '@/server/services/figma/plugin-http';
import { RateLimiter } from '@/server/services/figma/rate-limit';
import { createPluginToken } from '@/server/services/plugin-tokens';
import { upsertMember } from '@/server/services/workspaces';
import type { Actor } from '@/server/services/types';
import { makeActor, reset, testDb } from './helpers';
import { mirrorVerifier } from './figma-membership';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

async function member(role: Actor['role'], ws?: Actor['workspace']) {
  const a = await makeActor(db, role, ws);
  await upsertMember(db, a.workspace.id, a.userId, role);
  return a;
}

const req = (path: string, init: RequestInit & { token?: string; origin?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  if (init.origin) headers.set('origin', init.origin);
  return new Request(`http://localhost/api/figma/plugin${path}`, { ...init, headers });
};

const projectsRoute = pluginRoute(
  async ({ actor, db }) => ({ projects: await listProjectsForPlugin(db, actor) }),
  { db: () => db, verify: mirrorVerifier(db) },
);
const framesRoute = pluginRoute<{ projectId: string }>(
  async ({ actor, db, params }) => listFramesForPlugin(db, actor, params.projectId),
  { db: () => db, verify: mirrorVerifier(db) },
);

describe('plugin API auth and CORS', () => {
  it('lists projects and frames with a bearer token and no Clerk session', async () => {
    const editor = await member('editor');
    const p = await createProject(db, editor, { name: 'Landing' });
    const { token } = await createPluginToken(db, editor, { name: 'fig' });

    const res = await projectsRoute(req('/projects', { token, origin: 'null' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('null');
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    const body = (await res.json()) as { projects: { id: string; name: string }[] };
    expect(body.projects.map((x) => x.name)).toEqual(['Landing']);

    const fr = await framesRoute(req(`/projects/${p.id}/frames`, { token }), {
      params: Promise.resolve({ projectId: p.id }),
    });
    expect(fr.status).toBe(200);
    const frames = (await fr.json()) as { frames: { name: string; width: number }[] };
    expect(frames.frames).toEqual([
      expect.objectContaining({ name: 'Desktop', width: 1280, nodeCount: 1 }),
    ]);
  });

  it('rejects missing/invalid tokens with 401 and other workspaces with 404', async () => {
    const editor = await member('editor');
    const other = await member('editor');
    const p = await createProject(db, other, { name: 'Secret' });
    const { token } = await createPluginToken(db, editor, { name: 'fig' });

    expect((await projectsRoute(req('/projects'))).status).toBe(401);
    expect((await projectsRoute(req('/projects', { token: 'cdp_wrong' }))).status).toBe(401);
    const res = await framesRoute(req(`/projects/${p.id}/frames`, { token }), {
      params: Promise.resolve({ projectId: p.id }),
    });
    expect(res.status).toBe(404);
  });

  it('enforces the member role from the members table', async () => {
    const viewer = await member('viewer');
    const { token } = await createPluginToken(db, viewer, { name: 'fig' });
    const editRoute = pluginRoute(
      async ({ actor }) => {
        assertCan(actor.role, 'design:edit');
        return { ok: true };
      },
      { db: () => db, verify: mirrorVerifier(db) },
    );
    expect((await editRoute(req('/x', { token }))).status).toBe(403);
    await upsertMember(db, viewer.workspace.id, viewer.userId, 'editor');
    expect((await editRoute(req('/x', { token }))).status).toBe(200);
  });

  it('answers preflight only for the plugin null origin and refuses other web origins', async () => {
    const ok = pluginPreflight(req('/projects', { method: 'OPTIONS', origin: 'null' }));
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('null');
    expect(ok.headers.get('access-control-allow-headers')).toContain('Authorization');

    const evil = pluginPreflight(
      req('/projects', { method: 'OPTIONS', origin: 'https://evil.example' }),
    );
    expect(evil.status).toBe(403);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();

    const editor = await member('editor');
    const { token } = await createPluginToken(db, editor, { name: 'fig' });
    const res = await projectsRoute(req('/projects', { token, origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('returns 503 (fail closed) when membership cannot be verified with Clerk', async () => {
    const editor = await member('editor');
    const { token } = await createPluginToken(db, editor, { name: 'fig' });
    const route = pluginRoute(async () => ({ ok: true }), {
      db: () => db,
      verify: async () => {
        throw new Error('clerk down');
      },
    });
    const res = await route(req('/me', { token }));
    expect(res.status).toBe(503);
  });

  it('rate-limits per token', async () => {
    const editor = await member('editor');
    const { token } = await createPluginToken(db, editor, { name: 'fig' });
    const meRoute = pluginRoute(async () => ({ ok: true }), {
      db: () => db,
      verify: mirrorVerifier(db),
    });
    let last = 0;
    for (let i = 0; i <= PLUGIN_RATE_LIMIT; i++)
      last = (await meRoute(req('/me', { token }))).status;
    expect(last).toBe(429);
  });

  it('caps and validates JSON bodies', async () => {
    const schema = z.object({ a: z.number() }).strict();
    const big = new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({ a: 1, pad: 'x'.repeat(2000) }),
    });
    await expect(pluginBody(big, schema, 1000)).rejects.toThrow('Request body too large');
    const bad = new Request('http://x', { method: 'POST', body: '{"a":"no"}' });
    await expect(pluginBody(bad, schema, 1000)).rejects.toThrow(/Invalid request/);
    const good = new Request('http://x', { method: 'POST', body: '{"a":1}' });
    expect(await pluginBody(good, schema, 1000)).toEqual({ a: 1 });
  });
});

describe('RateLimiter', () => {
  it('resets after the window', () => {
    let t = 0;
    const rl = new RateLimiter(2, 1000, () => t);
    expect(rl.hit('k').ok).toBe(true);
    expect(rl.hit('k').ok).toBe(true);
    expect(rl.hit('k').ok).toBe(false);
    expect(rl.hit('other').ok).toBe(true);
    t = 1000;
    expect(rl.hit('k').ok).toBe(true);
  });
});
