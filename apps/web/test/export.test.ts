import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { activity, eq } from '@crunch/db';
import { newId, replaceDocOps, sampleLandingDoc, type DocOp } from '@crunch/doc-model';
import { readZipEntries } from '@crunch/handoff';
import { commitTransaction, getDoc } from '@/server/services/design-docs';
import { blobAssetFetcher, exportDesign, isBundlableAssetUrl } from '@/server/services/export';
import { createProject } from '@/server/services/projects';
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
  const project = await createProject(db, editor, { name: 'My Landing Page' });
  const { doc } = await getDoc(db, editor, project.id);
  await commit(editor, project.id, replaceDocOps(doc, sampleLandingDoc()));
  return { editor, viewer, project };
}

const noFetch = async () => null;

describe('HTML / ZIP export', () => {
  it('lets viewers export standalone HTML', async () => {
    const { viewer, project } = await setup();
    const f = await exportDesign(db, viewer, project.id, { format: 'html' });
    expect(f.filename).toBe('my-landing-page.html');
    expect(f.contentType).toContain('text/html');
    const html = f.body as string;
    expect(html).toContain('<title>My Landing Page</title>');
    expect(html).not.toContain('data-cd-id');
    expect(html).toContain('Ship designs your engineers can build.');
    const [row] = await db.select().from(activity).where(eq(activity.projectId, project.id));
    expect(row).toMatchObject({ verb: 'export.created', actorId: viewer.userId });
  });

  it('exports a ZIP with one page per frame', async () => {
    const { viewer, project } = await setup();
    const f = await exportDesign(
      db,
      viewer,
      project.id,
      { format: 'zip' },
      { fetchAsset: noFetch },
    );
    expect(f.filename).toBe('my-landing-page.zip');
    const entries = await readZipEntries(f.body as Uint8Array);
    expect([...entries.keys()]).toEqual([
      'README.txt',
      'frames/landing-desktop.html',
      'index.html',
    ]);
  });

  it('exports a saved version and a frame subset', async () => {
    const { editor, project } = await setup();
    const v = await createNamedVersion(db, editor, project.id, { name: 'v1' });
    await commit(editor, project.id, [
      { op: 'setProps', id: 'n_herotitle1', patch: { text: 'Changed later' } },
    ]);
    const live = (await exportDesign(db, editor, project.id, { format: 'html' })).body as string;
    expect(live).toContain('Changed later');
    const old = (
      await exportDesign(db, editor, project.id, {
        format: 'html',
        versionId: v.id,
        frameIds: [sampleLandingDoc().frames[0]!.id],
      })
    ).body as string;
    expect(old).not.toContain('Changed later');
    await expect(
      exportDesign(db, editor, project.id, { format: 'html', frameIds: ['f_nope000001'] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(exportDesign(db, editor, project.id, { format: 'pdf' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('is workspace-scoped', async () => {
    const { project } = await setup();
    const outsider = await makeActor(db, 'admin');
    await expect(exportDesign(db, outsider, project.id, { format: 'html' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('asset fetcher (SSRF guard)', () => {
  it('only allows https URLs on our blob storage', () => {
    expect(isBundlableAssetUrl('https://abc123.public.blob.vercel-storage.com/a.png')).toBe(true);
    for (const bad of [
      'http://abc.public.blob.vercel-storage.com/a.png',
      'https://evil.com/a.png',
      'https://abc.public.blob.vercel-storage.com.evil.com/a.png',
      'https://user:pw@abc.public.blob.vercel-storage.com/a.png',
      'https://abc.public.blob.vercel-storage.com:8443/a.png',
      'https://169.254.169.254/latest',
      'not a url',
    ])
      expect(isBundlableAssetUrl(bad)).toBe(false);
  });

  it('never fetches disallowed hosts and rejects non-images', async () => {
    const f = vi.fn(async () => new Response('x', { headers: { 'content-type': 'text/html' } }));
    const fetchAsset = blobAssetFetcher(f as unknown as typeof fetch);
    expect(await fetchAsset('https://evil.com/a.png')).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(await fetchAsset('https://a.public.blob.vercel-storage.com/a.png')).toBeNull();
    expect(f).toHaveBeenCalledWith(
      'https://a.public.blob.vercel-storage.com/a.png',
      expect.objectContaining({ redirect: 'error' }),
    );
  });
});
