/**
 * Plugin image import (Story 8.3): realistic-size images are validated and stored as assets, and
 * referenced by https URL (DesignDoc image sources are capped at 4 KB, so data URLs can't be used).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { assets, eq } from '@crunch/db';
import { parseDoc } from '@crunch/doc-model';
import { getDoc } from '@/server/services/design-docs';
import { importFigmaNodes } from '@/server/services/figma';
import { decodeRasterDataUrl, type ImageUploader } from '@/server/services/figma/assets';
import { createProject } from '@/server/services/projects';
import { makeActor, reset, testDb } from './helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A ~300 KB "PNG" (valid signature, random body): the size of a typical photo fill. */
const bigPng = () =>
  `data:image/png;base64,${Buffer.concat([PNG_SIG, randomBytes(300_000)]).toString('base64')}`;

const frame = (imageRefs: string[]) => ({
  id: '1:1',
  name: 'Gallery',
  type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 800, height: 600 },
  layoutMode: 'HORIZONTAL',
  children: imageRefs.map((ref, i) => ({
    id: `1:${i + 2}`,
    name: `Photo ${i}`,
    type: 'RECTANGLE',
    absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 150 },
    fills: [{ type: 'IMAGE', imageRef: ref, scaleMode: 'FILL' }],
  })),
});

function fakeUploader() {
  const calls: { pathname: string; size: number; type: string }[] = [];
  const uploader: ImageUploader = async (pathname, bytes, contentType) => {
    calls.push({ pathname, size: bytes.length, type: contentType });
    return { url: `https://blob.example.com/${pathname}`, pathname };
  };
  return { uploader, calls };
}

async function setup() {
  const actor = await makeActor(db, 'editor');
  const p = await createProject(db, actor, { name: 'Images' });
  return { actor, projectId: p.id };
}

describe('plugin image import', () => {
  it('stores realistic images as figma assets and references them by https URL', async () => {
    const { actor, projectId } = await setup();
    const { uploader, calls } = fakeUploader();
    const img = bigPng();
    const res = await importFigmaNodes(
      db,
      actor,
      projectId,
      { nodes: [frame(['a', 'b'])], images: { a: img, b: img }, source: 'plugin' },
      { uploader },
    );
    expect(res.stats.images).toBe(2);
    expect(calls).toHaveLength(1); // same content uploaded once
    expect(calls[0]).toMatchObject({ type: 'image/png', size: 300_008 });
    expect(calls[0]!.pathname).toMatch(
      new RegExp(`^workspaces/${actor.workspace.id}/figma/[0-9a-f]{64}\\.png$`),
    );

    const rows = await db.select().from(assets).where(eq(assets.projectId, projectId));
    expect(rows).toEqual([
      expect.objectContaining({
        kind: 'figma',
        contentType: 'image/png',
        sizeBytes: 300_008,
        workspaceId: actor.workspace.id,
      }),
    ]);
    const { doc } = await getDoc(db, actor, projectId);
    expect(() => parseDoc(doc)).not.toThrow();
    const images = Object.values(doc.nodes).filter((n) => n.type === 'image');
    expect(images).toHaveLength(2);
    for (const n of images) expect(n.type === 'image' && n.props.src).toBe(rows[0]!.blobUrl);

    // A second import of the same image reuses the stored asset.
    await importFigmaNodes(
      db,
      actor,
      projectId,
      { nodes: [frame(['c'])], images: { c: img }, source: 'plugin' },
      { uploader },
    );
    expect(calls).toHaveLength(1);
  });

  it('without storage, large images become placeholders with a clear report entry', async () => {
    const { actor, projectId } = await setup();
    const res = await importFigmaNodes(
      db,
      actor,
      projectId,
      { nodes: [frame(['a'])], images: { a: bigPng() }, source: 'plugin' },
      { uploader: null },
    );
    expect(res.stats.images).toBe(0);
    expect(res.report.some((r) => /BLOB_READ_WRITE_TOKEN/.test(r.message))).toBe(true);
  });

  it('rejects mislabeled, non-raster and oversized data', async () => {
    expect(
      decodeRasterDataUrl(
        `data:image/jpeg;base64,${Buffer.concat([PNG_SIG, randomBytes(10)]).toString('base64')}`,
      ),
    ).toEqual({ error: 'contents are not a image/jpeg image' });
    expect(decodeRasterDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toMatchObject({
      error: expect.stringMatching(/not an allowed/),
    });
    expect(
      decodeRasterDataUrl(
        `data:image/png;base64,${Buffer.concat([PNG_SIG, Buffer.alloc(2 * 1024 * 1024)]).toString('base64')}`,
      ),
    ).toEqual({ error: 'image is too large' });
    expect(decodeRasterDataUrl(bigPng())).toMatchObject({ contentType: 'image/png', ext: 'png' });

    const { actor, projectId } = await setup();
    const { uploader, calls } = fakeUploader();
    const res = await importFigmaNodes(
      db,
      actor,
      projectId,
      { nodes: [frame(['a'])], images: { a: 'data:image/png;base64,AAAA' }, source: 'plugin' },
      { uploader },
    );
    expect(calls).toHaveLength(0);
    expect(res.report.some((r) => /Image rejected/.test(r.message))).toBe(true);
  });

  it('dry runs never upload', async () => {
    const { actor, projectId } = await setup();
    const { uploader, calls } = fakeUploader();
    await importFigmaNodes(
      db,
      actor,
      projectId,
      { nodes: [frame(['a'])], images: { a: bigPng() }, source: 'plugin' },
      { uploader, dryRun: true },
    );
    expect(calls).toHaveLength(0);
  });
});
