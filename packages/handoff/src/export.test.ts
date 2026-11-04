import { applyOps, sampleLandingDoc, starterDesignSystem, type DesignDoc } from '@crunch/doc-model';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { collectImageSources, rewriteImageSources } from './assets';
import { ExportError, exportHtml, slugify, uniqueSlugs } from './html';
import { buildExportZip } from './zip';

const ds = starterDesignSystem();
const IMG = 'https://abc.public.blob.vercel-storage.com/hero.png';

function docWithImage(): DesignDoc {
  return applyOps(sampleLandingDoc(), [
    {
      op: 'insertSubtree',
      parentId: 'n_hero000001',
      index: 0,
      nodes: [
        {
          id: 'n_img0000001',
          type: 'image',
          parentId: 'n_hero000001',
          children: [],
          positioning: 'flow',
          style: { base: { width: 120 } },
          props: { src: IMG, alt: 'Hero' },
        },
      ],
    },
  ]).doc;
}

describe('exportHtml', () => {
  it('produces a standalone page without annotations or scripts', () => {
    const { html } = exportHtml(sampleLandingDoc(), ds);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toContain('data-cd-id');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/<link\b/);
    expect(html).toContain('@container cdframe');
    expect(html).toContain('width:100%'); // fluid frames
    expect(html).toContain('Ship designs your engineers can build.');
  });

  it('is deterministic and validates frame ids', () => {
    const a = exportHtml(sampleLandingDoc(), ds).html;
    expect(exportHtml(sampleLandingDoc(), ds).html).toBe(a);
    expect(() => exportHtml(sampleLandingDoc(), ds, { frameIds: ['f_nope000001'] })).toThrow(
      ExportError,
    );
    expect(() => exportHtml({ ...sampleLandingDoc(), frames: [] }, ds)).toThrow(ExportError);
  });
});

describe('slugs', () => {
  it('makes safe unique file names', () => {
    expect(slugify('Landing — Desktop!')).toBe('landing-desktop');
    expect(slugify('../../etc')).toBe('etc');
    expect(slugify('***')).toBe('frame');
    expect(uniqueSlugs(['A', 'a', 'A'])).toEqual(['a', 'a-2', 'a-3']);
  });
});

describe('image sources', () => {
  it('collects and rewrites remote image sources', () => {
    const doc = docWithImage();
    expect(collectImageSources(doc)).toEqual([IMG]);
    const out = rewriteImageSources(doc, new Map([[IMG, 'assets/x.png']]));
    expect((out.nodes.n_img0000001 as { props: { src: string } }).props.src).toBe('assets/x.png');
    expect((doc.nodes.n_img0000001 as { props: { src: string } }).props.src).toBe(IMG); // pure
  });
});

describe('buildExportZip', () => {
  it('contains index.html, one page per frame and a README', async () => {
    const r = await buildExportZip(sampleLandingDoc(), ds, { title: 'Landing' });
    expect(r.files).toEqual(['README.txt', 'frames/landing-desktop.html', 'index.html']);
    const zip = await JSZip.loadAsync(r.zip);
    const index = await zip.file('index.html')!.async('string');
    expect(index).toBe(exportHtml(sampleLandingDoc(), ds, { title: 'Landing' }).html);
  });

  it('is byte-for-byte deterministic', async () => {
    const a = await buildExportZip(sampleLandingDoc(), ds);
    const b = await buildExportZip(sampleLandingDoc(), ds);
    expect(Buffer.from(a.zip).equals(Buffer.from(b.zip))).toBe(true);
  });

  it('bundles fetched images for offline use with page-relative paths', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const r = await buildExportZip(docWithImage(), ds, {
      fetchAsset: async (src) => (src === IMG ? { bytes: png, contentType: 'image/png' } : null),
    });
    const asset = r.files.find((f) => f.startsWith('assets/'))!;
    expect(asset).toMatch(/^assets\/[0-9a-f]{16}\.png$/);
    const zip = await JSZip.loadAsync(r.zip);
    expect(await zip.file('index.html')!.async('string')).toContain(`src="${asset}"`);
    expect(await zip.file('frames/landing-desktop.html')!.async('string')).toContain(
      `src="../${asset}"`,
    );
    expect(await zip.file('index.html')!.async('string')).not.toContain(IMG);
    expect(new Uint8Array(await zip.file(asset)!.async('uint8array'))).toEqual(png);
  });

  it('keeps images remote when they cannot be fetched and says so', async () => {
    const r = await buildExportZip(docWithImage(), ds, { fetchAsset: async () => null });
    expect(r.files.some((f) => f.startsWith('assets/'))).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/stay remote/);
    const zip = await JSZip.loadAsync(r.zip);
    expect(await zip.file('README.txt')!.async('string')).toContain(IMG);
  });

  it('adds extra files but rejects path traversal', async () => {
    const r = await buildExportZip(sampleLandingDoc(), ds, {
      extraFiles: { 'handoff.json': '{}' },
    });
    expect(r.files).toContain('handoff.json');
    await expect(
      buildExportZip(sampleLandingDoc(), ds, { extraFiles: { '../x': '' } }),
    ).rejects.toThrow();
  });
});
