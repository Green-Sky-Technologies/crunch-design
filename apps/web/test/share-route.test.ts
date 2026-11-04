/**
 * Route-handler tests for the share viewer (GET /s/:token): limiter wiring, response headers on
 * every status, and the anonymous vs signed-in branches for workspace-only links.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Db } from '@crunch/db';
import type { Actor } from '@/server/services/types';

const h = vi.hoisted(() => ({ db: null as unknown as Db, actor: null as Actor | null }));

vi.mock('@/server/context', () => ({ getActor: vi.fn(async () => h.actor) }));
vi.mock('@crunch/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@crunch/db')>()),
  getDb: () => h.db,
}));

const { GET } = await import('@/app/s/[token]/route');
const { createShareLink } = await import('@/server/services/share-links');
const { createProject } = await import('@/server/services/projects');
const { commitTransaction, getDoc } = await import('@/server/services/design-docs');
const { newId, replaceDocOps, sampleLandingDoc } = await import('@crunch/doc-model');
const { makeActor, reset, testDb } = await import('./helpers');

const { db, close } = testDb();
h.db = db;
afterAll(close);
beforeEach(async () => {
  h.actor = null;
  await reset(db);
});

let ipCounter = 0;
/** A fresh client IP per call, so tests don't share limiter buckets. */
const freshIp = () => `203.0.113.${(ipCounter = (ipCounter % 250) + 1)}`;

function get(token: string, headers: Record<string, string> = { 'x-real-ip': freshIp() }) {
  const req = new NextRequest(`http://localhost/s/${token}`, { headers });
  return GET(req, { params: Promise.resolve({ token }) } as RouteContext<'/s/[token]'>);
}

async function setup() {
  const editor = await makeActor(db, 'editor');
  const project = await createProject(db, editor, { name: 'Route Project' });
  const { doc, version } = await getDoc(db, editor, project.id);
  await commitTransaction(db, editor, project.id, {
    baseVersion: version,
    txn: {
      id: `t_${newId('s').slice(2)}`,
      source: 'canvas',
      ops: replaceDocOps(doc, sampleLandingDoc()),
    },
  });
  return { editor, project };
}

function expectShareHeaders(res: Response) {
  expect(res.headers.get('content-type')).toContain('text/html');
  expect(res.headers.get('x-robots-tag')).toContain('noindex');
  expect(res.headers.get('cache-control')).toContain('no-store');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  expect(res.headers.get('x-frame-options')).toBe('DENY');
}

describe('GET /s/:token', () => {
  it('renders a public link anonymously with hardened headers', async () => {
    const { editor, project } = await setup();
    const { token } = await createShareLink(db, editor, {
      projectId: project.id,
      visibility: 'public',
    });
    const res = await get(token);
    expect(res.status).toBe(200);
    expectShareHeaders(res);
    const html = await res.text();
    expect(html).toContain('Ship designs your engineers can build.');
    expect(html).not.toContain('Route Project');
  });

  it('workspace links: anonymous gets 404 + sign-in hint, members see it, outsiders get 404', async () => {
    const { editor, project } = await setup();
    const { token } = await createShareLink(db, editor, { projectId: project.id });

    const anon = await get(token);
    expect(anon.status).toBe(404);
    expectShareHeaders(anon);
    expect(await anon.text()).toContain(
      `/sign-in?redirect_url=${encodeURIComponent(`/s/${token}`)}`,
    );

    h.actor = await makeActor(db, 'viewer', editor.workspace);
    const member = await get(token);
    expect(member.status).toBe(200);

    h.actor = await makeActor(db, 'admin'); // another workspace
    const outsider = await get(token);
    expect(outsider.status).toBe(404);
    const body = await outsider.text();
    expect(body).not.toContain('sign-in'); // signed in: no hint, same page as an unknown token
    h.actor = await makeActor(db, 'admin');
    expect(await (await get('Z'.repeat(43))).text()).toBe(body);
  });

  it('treats auth failures as anonymous', async () => {
    const { editor, project } = await setup();
    const { token } = await createShareLink(db, editor, {
      projectId: project.id,
      visibility: 'public',
    });
    const ctx = await import('@/server/context');
    vi.mocked(ctx.getActor).mockRejectedValueOnce(new Error('clerk down'));
    expect((await get(token)).status).toBe(200);
  });

  it('rate-limits per client IP with 429 + Retry-After and the same headers', async () => {
    const ip = '198.51.100.7';
    for (let i = 0; i < 60; i++) expect((await get('bogus', { 'x-real-ip': ip })).status).toBe(404);
    const limited = await get('bogus', { 'x-real-ip': ip });
    expect(limited.status).toBe(429);
    expectShareHeaders(limited);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    // A spoofed leftmost x-forwarded-for doesn't escape the limit when x-real-ip is set.
    const spoofed = await get('bogus', { 'x-real-ip': ip, 'x-forwarded-for': '1.1.1.1' });
    expect(spoofed.status).toBe(429);
    // Other clients are unaffected.
    expect((await get('bogus', { 'x-real-ip': '198.51.100.8' })).status).toBe(404);
  });

  it('buckets IP-less requests per token, not in one shared bucket', async () => {
    for (let i = 0; i < 60; i++) await get('a'.repeat(43), {});
    expect((await get('a'.repeat(43), {})).status).toBe(429);
    expect((await get('b'.repeat(43), {})).status).toBe(404); // different link: not locked out
  });
});
