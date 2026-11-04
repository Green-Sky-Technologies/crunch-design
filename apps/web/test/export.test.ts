import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HANDOFF_SCHEMA_VERSION, handoffBundle } from '@crunch/contracts';
import { activity, agentConversations, eq, projects } from '@crunch/db';
import { newId, replaceDocOps, sampleLandingDoc, type DocOp } from '@crunch/doc-model';
import { readZipEntries } from '@crunch/handoff';
import { commitTransaction, getDoc } from '@/server/services/design-docs';
import {
  blobAssetFetcher,
  buildProjectHandoff,
  exportDesign,
  isBundlableAssetUrl,
} from '@/server/services/export';
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

describe('handoff bundle export', () => {
  it('produces a contract-valid bundle with intent from versions and conversations', async () => {
    const { editor, viewer, project } = await setup();
    await db
      .update(projects)
      .set({ description: 'Marketing site' })
      .where(eq(projects.id, project.id));
    await createNamedVersion(db, editor, project.id, {
      name: 'Review',
      description: 'Hero approved',
    });
    await db.insert(agentConversations).values({
      workspaceId: editor.workspace.id,
      projectId: project.id,
      title: 'Make the hero bolder',
      createdBy: editor.userId,
    });
    const bundle = await buildProjectHandoff(db, viewer, project.id);
    expect(handoffBundle.safeParse(bundle).success).toBe(true);
    expect(bundle.schemaVersion).toBe(HANDOFF_SCHEMA_VERSION);
    expect(bundle.project).toEqual({
      id: project.id,
      name: 'My Landing Page',
      description: 'Marketing site',
    });
    expect(bundle.intent.summary).toContain('Marketing site');
    expect(bundle.intent.notes).toEqual([
      'Version “Review”: Hero approved',
      'Agent conversation: Make the hero bolder',
    ]);
  });

  it('downloads handoff.json and a handoff ZIP (viewers allowed)', async () => {
    const { viewer, project } = await setup();
    const json = await exportDesign(db, viewer, project.id, { format: 'handoff' });
    expect(json.filename).toBe('my-landing-page.handoff.json');
    expect(handoffBundle.safeParse(JSON.parse(json.body as string)).success).toBe(true);

    const zip = await exportDesign(
      db,
      viewer,
      project.id,
      { format: 'handoff-zip' },
      { fetchAsset: noFetch },
    );
    expect(zip.filename).toBe('my-landing-page-handoff.zip');
    const entries = await readZipEntries(zip.body as Uint8Array);
    expect([...entries.keys()]).toEqual([
      'HANDOFF.md',
      'README.txt',
      'frames/landing-desktop.html',
      'handoff.json',
      'handoff.schema.json',
      'index.html',
    ]);
    const parsed = JSON.parse(new TextDecoder().decode(entries.get('handoff.json')));
    expect(handoffBundle.safeParse(parsed).success).toBe(true);
  });

  it('exports the same version as byte-identical handoff ZIPs (generatedAt = version time)', async () => {
    const { editor, project } = await setup();
    const v = await createNamedVersion(db, editor, project.id, { name: 'v1', description: 'n' });
    const exportIt = async () =>
      (
        await exportDesign(
          db,
          editor,
          project.id,
          { format: 'handoff-zip', versionId: v.id },
          { fetchAsset: noFetch },
        )
      ).body as Uint8Array;
    const first = await exportIt();
    await new Promise((r) => setTimeout(r, 20));
    // Later edits and later versions don't change an export of v1.
    await commit(editor, project.id, [
      { op: 'setProps', id: 'n_herotitle1', patch: { text: 'Later edit' } },
    ]);
    await createNamedVersion(db, editor, project.id, { name: 'v2', description: 'later' });
    const second = await exportIt();
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);

    const bundle = await buildProjectHandoff(db, editor, project.id, { versionId: v.id });
    expect(bundle.generatedAt).toBe(v.createdAt.toISOString());
    expect(bundle.intent.notes).toEqual(['Version “v1”: n']);
  });

  it('exports the unchanged live design identically, and changes after an edit', async () => {
    const { editor, project } = await setup();
    const live = async () =>
      (await exportDesign(db, editor, project.id, { format: 'handoff' })).body as string;
    const a = await live();
    await new Promise((r) => setTimeout(r, 20));
    expect(await live()).toBe(a);
    await commit(editor, project.id, [
      { op: 'setProps', id: 'n_herotitle1', patch: { text: 'Edited' } },
    ]);
    const c = await live();
    expect(c).not.toBe(a);
    expect(JSON.parse(c).generatedAt > JSON.parse(a).generatedAt).toBe(true);
  });

  it('is workspace-scoped', async () => {
    const { project } = await setup();
    const outsider = await makeActor(db, 'admin');
    await expect(buildProjectHandoff(db, outsider, project.id)).rejects.toBeInstanceOf(
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
    expect(await fetchAsset('https://evil.com/a.png', opts())).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(await fetchAsset('https://a.public.blob.vercel-storage.com/a.png', opts())).toBeNull();
    expect(f).toHaveBeenCalledWith(
      'https://a.public.blob.vercel-storage.com/a.png',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  const URL_OK = 'https://a.public.blob.vercel-storage.com/a.png';

  it('rejects an oversized body without content-length while streaming', async () => {
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(1024 * 1024)); // endless 1 MB chunks
      },
      cancel() {
        cancelled = true;
      },
    });
    const f = async () => new Response(body, { headers: { 'content-type': 'image/png' } });
    const fetchAsset = blobAssetFetcher(f as unknown as typeof fetch);
    expect(await fetchAsset(URL_OK, opts(5 * 1024 * 1024))).toBeNull();
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10); // stopped early, not after reading everything
  });

  it('returns null on timeout and on non-OK responses', async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) =>
        init?.signal?.addEventListener('abort', () =>
          rej(new DOMException('aborted', 'AbortError')),
        ),
      );
    const slow = blobAssetFetcher(hang as unknown as typeof fetch, { timeoutMs: 30 });
    expect(await slow(URL_OK, opts())).toBeNull();
    const notOk = blobAssetFetcher(
      (async () =>
        new Response('nope', {
          status: 404,
          headers: { 'content-type': 'image/png' },
        })) as unknown as typeof fetch,
    );
    expect(await notOk(URL_OK, opts())).toBeNull();
  });

  it('respects the overall budget signal and remaining bytes', async () => {
    const f = vi.fn(
      async () => new Response(new Uint8Array(100), { headers: { 'content-type': 'image/png' } }),
    );
    const fetchAsset = blobAssetFetcher(f as unknown as typeof fetch);
    const ac = new AbortController();
    ac.abort();
    expect(await fetchAsset(URL_OK, { signal: ac.signal, maxBytes: 1e6 })).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(await fetchAsset(URL_OK, opts(50))).toBeNull(); // 100-byte body over the 50 left
    expect((await fetchAsset(URL_OK, opts(200)))?.bytes.byteLength).toBe(100);
  });

  it('restricts to configured hosts when EXPORT_ASSET_HOSTS is set', () => {
    expect(isBundlableAssetUrl(URL_OK, ['ours.public.blob.vercel-storage.com'])).toBe(false);
    expect(
      isBundlableAssetUrl('https://ours.public.blob.vercel-storage.com/x.png', [
        'ours.public.blob.vercel-storage.com',
      ]),
    ).toBe(true);
    vi.stubEnv('EXPORT_ASSET_HOSTS', 'ours.public.blob.vercel-storage.com');
    try {
      expect(isBundlableAssetUrl(URL_OK)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(isBundlableAssetUrl(URL_OK)).toBe(true);
  });
});

function opts(maxBytes = 10 * 1024 * 1024) {
  return { signal: new AbortController().signal, maxBytes };
}
