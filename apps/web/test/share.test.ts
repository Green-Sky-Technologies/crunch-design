import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@crunch/authz';
import { eq, projects, shareLinks } from '@crunch/db';
import { newId, replaceDocOps, sampleLandingDoc, type DocOp } from '@crunch/doc-model';
import { renderShareError, renderSharePage, shareHeaders } from '@/app/s/[token]/share-html';
import { commitTransaction, getDoc } from '@/server/services/design-docs';
import { createProject } from '@/server/services/projects';
import {
  clientIp,
  createShareLink,
  hashShareToken,
  listShareLinks,
  RateLimiter,
  resolveShareToken,
  shareRateKey,
  revokeShareLink,
  updateShareLink,
} from '@/server/services/share-links';
import { NotFoundError, ValidationError, type Actor } from '@/server/services/types';
import { createNamedVersion } from '@/server/services/versions';
import { makeActor, reset, testDb } from './helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

async function commit(actor: Actor, projectId: string, ops: DocOp[]) {
  const { version } = await getDoc(db, actor, projectId);
  return commitTransaction(db, actor, projectId, {
    baseVersion: version,
    txn: { id: `t_${newId('s').slice(2)}`, source: 'canvas', ops },
  });
}

async function setup() {
  const editor = await makeActor(db, 'editor');
  const viewer = await makeActor(db, 'viewer', editor.workspace);
  const project = await createProject(db, editor, {
    name: 'Secret Project Name',
    description: 'Confidential roadmap',
  });
  const { doc } = await getDoc(db, editor, project.id);
  await commit(editor, project.id, replaceDocOps(doc, sampleLandingDoc()));
  return { editor, viewer, project };
}

const expectNotFound = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(NotFoundError);

describe('share links', () => {
  it('stores only a SHA-256 of a 32-byte random token', async () => {
    const { editor, project } = await setup();
    const { token, path, link } = await createShareLink(db, editor, { projectId: project.id });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(path).toBe(`/s/${token}`);
    expect(link.visibility).toBe('workspace');
    const [row] = await db.select().from(shareLinks).where(eq(shareLinks.id, link.id));
    expect(row!.tokenHash).toBe(hashShareToken(token));
    expect(row!.tokenHash).not.toContain(token);
    expect(JSON.stringify(link)).not.toContain(row!.tokenHash);
    const second = await createShareLink(db, editor, { projectId: project.id });
    expect(second.token).not.toBe(token);
  });

  it('workspace-only links require a signed-in member of that workspace', async () => {
    const { editor, viewer, project } = await setup();
    const { token } = await createShareLink(db, editor, { projectId: project.id });
    await expectNotFound(resolveShareToken(db, token, null));
    const outsider = await makeActor(db, 'admin');
    await expectNotFound(resolveShareToken(db, token, outsider));
    const shared = await resolveShareToken(db, token, viewer);
    expect(shared.frameIds).toEqual(sampleLandingDoc().frames.map((f) => f.id));
  });

  it('public links need no auth and expose only the rendered design', async () => {
    const { editor, project } = await setup();
    const { token } = await createShareLink(db, editor, {
      projectId: project.id,
      visibility: 'public',
    });
    const shared = await resolveShareToken(db, token, null);
    expect(Object.keys(shared).sort()).toEqual(['designSystem', 'doc', 'frameIds', 'visibility']);
    const html = renderSharePage(shared.doc, shared.designSystem, shared.frameIds);
    expect(html).toContain('noindex');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('data-cd-id');
    for (const secret of [
      project.name,
      'Confidential roadmap',
      project.id,
      editor.workspace.id,
      editor.workspace.name,
      editor.workspace.slug,
      editor.userId,
    ])
      expect(html).not.toContain(secret);
    expect(html).toContain('Ship designs your engineers can build.');
  });

  it('counts views', async () => {
    const { editor, project } = await setup();
    const { token, link } = await createShareLink(db, editor, {
      projectId: project.id,
      visibility: 'public',
    });
    await resolveShareToken(db, token, null);
    await resolveShareToken(db, token, null);
    const [l] = await listShareLinks(db, editor, project.id);
    expect(l!.id).toBe(link.id);
    expect(l!.viewCount).toBe(2);
    expect(l!.lastViewedAt).not.toBeNull();
  });

  it('expired, revoked, archived, unknown and malformed tokens all look the same', async () => {
    const { editor, project } = await setup();
    const make = () => createShareLink(db, editor, { projectId: project.id, visibility: 'public' });

    const expiring = await make();
    await resolveShareToken(db, expiring.token, null);
    await db
      .update(shareLinks)
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(shareLinks.id, expiring.link.id));
    await resolveShareToken(db, expiring.token, null); // not expired yet
    await expectNotFound(
      resolveShareToken(db, expiring.token, null, new Date(Date.now() + 120_000)),
    );

    const revoked = await make();
    const r = await revokeShareLink(db, editor, revoked.link.id);
    expect(r.active).toBe(false);
    await expectNotFound(resolveShareToken(db, revoked.token, null));

    await expectNotFound(resolveShareToken(db, 'A'.repeat(43), null));
    await expectNotFound(resolveShareToken(db, '../../etc', null));

    const archived = await make();
    await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, project.id));
    await expectNotFound(resolveShareToken(db, archived.token, null));
  });

  it('supports expiry, visibility changes and frame / version pinning', async () => {
    const { editor, project } = await setup();
    await expect(
      createShareLink(db, editor, {
        projectId: project.id,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createShareLink(db, editor, { projectId: project.id, frameIds: ['f_nope000001'] }),
    ).rejects.toBeInstanceOf(ValidationError);

    const frameId = sampleLandingDoc().frames[0]!.id;
    const v = await createNamedVersion(db, editor, project.id, { name: 'v1' });
    await commit(editor, project.id, [
      { op: 'setProps', id: 'n_herotitle1', patch: { text: 'Live headline' } },
    ]);
    const { token, link } = await createShareLink(db, editor, {
      projectId: project.id,
      frameIds: [frameId],
      docVersionId: v.id,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(link.expiresAt).not.toBeNull();
    const updated = await updateShareLink(db, editor, link.id, {
      visibility: 'public',
      expiresAt: null,
    });
    expect(updated.visibility).toBe('public');
    expect(updated.expiresAt).toBeNull();
    const shared = await resolveShareToken(db, token, null);
    expect(shared.frameIds).toEqual([frameId]);
    const html = renderSharePage(shared.doc, shared.designSystem, shared.frameIds);
    expect(html).not.toContain('Live headline'); // pinned to the named version

    await revokeShareLink(db, editor, link.id);
    await expect(
      updateShareLink(db, editor, link.id, { visibility: 'workspace' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('enforces share:manage and workspace scoping', async () => {
    const { editor, viewer, project } = await setup();
    await expect(createShareLink(db, viewer, { projectId: project.id })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(listShareLinks(db, viewer, project.id)).rejects.toBeInstanceOf(ForbiddenError);
    const { link } = await createShareLink(db, editor, { projectId: project.id });
    await expect(revokeShareLink(db, viewer, link.id)).rejects.toBeInstanceOf(ForbiddenError);
    const outsider = await makeActor(db, 'admin');
    await expectNotFound(createShareLink(db, outsider, { projectId: project.id }));
    await expectNotFound(listShareLinks(db, outsider, project.id));
    await expectNotFound(revokeShareLink(db, outsider, link.id));
    await expectNotFound(updateShareLink(db, outsider, link.id, { visibility: 'public' }));
    // Another workspace's version id can't be pinned.
    const otherProject = await createProject(db, outsider, { name: 'O' });
    const otherVersion = await createNamedVersion(db, outsider, otherProject.id, { name: 'x' });
    await expectNotFound(
      createShareLink(db, editor, { projectId: project.id, docVersionId: otherVersion.id }),
    );
  });
});

describe('share viewer helpers', () => {
  it('rate-limits per key within a window', () => {
    const rl = new RateLimiter(3, 1000);
    expect([0, 1, 2].map((t) => rl.check('a', t).ok)).toEqual([true, true, true]);
    const blocked = rl.check('a', 500);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(rl.check('b', 500).ok).toBe(true);
    expect(rl.check('a', 1001).ok).toBe(true);
  });

  it('bounds memory by evicting old keys', () => {
    const rl = new RateLimiter(1, 60_000, 2);
    rl.check('a', 0);
    rl.check('b', 0);
    rl.check('c', 0);
    expect(rl.check('a', 1).ok).toBe(true); // 'a' was evicted
  });

  it("keeps repeat clients' counters when flooded with one-off random keys", () => {
    const rl = new RateLimiter(3, 60_000, 50);
    for (let t = 0; t < 3; t++) expect(rl.check('ip:abuser', t).ok).toBe(true);
    expect(rl.check('ip:abuser', 3).ok).toBe(false);
    for (let i = 0; i < 10_000; i++) rl.check(`ip:random-${i}`, 10 + i / 1000);
    expect(rl.check('ip:abuser', 20).ok).toBe(false); // still limited: not evicted
    expect(rl.size).toBeLessThanOrEqual(100); // memory stays bounded
  });

  it('prefers platform-set IP headers over the client-controlled leftmost x-forwarded-for', () => {
    // Vercel sets x-real-ip; a spoofed leftmost XFF entry is ignored.
    expect(
      clientIp(new Headers({ 'x-real-ip': '5.6.7.8', 'x-forwarded-for': '6.6.6.6, 5.6.7.8' })),
    ).toBe('5.6.7.8');
    expect(clientIp(new Headers({ 'x-vercel-forwarded-for': '9.9.9.9' }))).toBe('9.9.9.9');
    // Without platform headers, trust only the entry the nearest proxy appended (rightmost).
    expect(clientIp(new Headers({ 'x-forwarded-for': '6.6.6.6, 10.0.0.1' }))).toBe('10.0.0.1');
    expect(clientIp(new Headers({ 'x-real-ip': 'not an ip; drop table' }))).toBeNull();
    expect(clientIp(new Headers())).toBeNull();
  });

  it('falls back to a per-token bucket when the IP is unknown (no shared "unknown" bucket)', () => {
    const none = new Headers();
    const a = shareRateKey(none, 'A'.repeat(43));
    const b = shareRateKey(none, 'B'.repeat(43));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^token:[0-9a-f]{32}$/);
    expect(a).not.toContain('A'.repeat(10)); // the raw token is never used as a key
    expect(shareRateKey(new Headers({ 'x-real-ip': '1.2.3.4' }), 'x')).toBe('ip:1.2.3.4');
  });

  it('sends noindex, no-store and a script-free CSP', () => {
    const h = new Headers(shareHeaders());
    expect(h.get('x-robots-tag')).toContain('noindex');
    expect(h.get('cache-control')).toContain('no-store');
    expect(h.get('content-security-policy')).toContain("default-src 'none'");
    expect(h.get('content-security-policy')).not.toContain('script-src');
    expect(renderShareError({ status: 404, signInHref: '/sign-in?x="y"' })).toContain(
      '/sign-in?x=&quot;y&quot;',
    );
  });
});
