/**
 * Story 7.1 AC: the exported HTML is visually identical to the canvas at each breakpoint.
 *
 * For each fixture and breakpoint width W:
 *   canvas  = FrameView (the live canvas renderer) with the frame at width W, in Shadow DOM
 *   export  = exportHtml() output (fluid frame) in a viewport W pixels wide
 * Both are screenshotted and diffed pixel by pixel in the browser; the share of differing
 * pixels must stay under THRESHOLD.
 *
 * The harness is bundled with esbuild (a devDependency of @crunch/handoff, loaded from there).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import {
  applyOps,
  sampleLandingDoc,
  starterDesignSystem,
  type DesignDoc,
  type DesignSystemSpec,
} from '@crunch/doc-model';
import { buildExportZip, exportHtml, readZipEntries } from '@crunch/handoff';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../..');
const handoffPkg = path.resolve(webRoot, '../../packages/handoff/package.json');

/** Max share of pixels allowed to differ (per-channel tolerance below absorbs AA noise). */
const THRESHOLD = 0.001;
const CHANNEL_TOLERANCE = 24;

const ds: DesignSystemSpec = starterDesignSystem();
const BREAKPOINTS = [
  { name: 'base', width: 390 },
  { name: 'md', width: ds.breakpoints.md + 32 },
  { name: 'lg', width: 1280 },
] as const;

/** 2x2 red/blue PNG as a data URL (no network needed). */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAwAAi/gMJABvyA/1NQqYrAAAAAElFTkSuQmCC';

function richDoc(): DesignDoc {
  return applyOps(sampleLandingDoc(), [
    {
      op: 'insertSubtree',
      parentId: 'n_nav0000001',
      index: 1,
      nodes: [
        {
          id: 'n_icon000001',
          type: 'svg',
          parentId: 'n_nav0000001',
          children: [],
          positioning: 'flow',
          style: { base: { width: 24, height: 24 } },
          props: {
            svg: '<svg viewBox="0 0 24 24" fill="none"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2"/></svg>',
            ariaLabel: 'Menu',
          },
        },
      ],
    },
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
          positioning: 'absolute',
          style: {
            base: { top: 8, right: 8, width: 48, height: 48 },
            lg: { width: 96, height: 96 },
          },
          props: { src: PNG, alt: 'Badge' },
        },
      ],
    },
    { op: 'setStyle', id: 'n_herotitle1', breakpoint: 'md', prop: 'color', value: '#b91c1c' },
  ]).doc;
}

const FIXTURES: { name: string; doc: () => DesignDoc }[] = [
  { name: 'sample landing', doc: sampleLandingDoc },
  { name: 'icons, images, absolute and breakpoint overrides', doc: richDoc },
];

let harnessJs = '';

test.beforeAll(async () => {
  // esbuild isn't an apps/web dependency; resolve it from @crunch/handoff (minimal typing).
  const esbuild = createRequire(handoffPkg)('esbuild') as {
    build(opts: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
  };
  const out = await esbuild.build({
    entryPoints: [path.join(here, 'harness-entry.tsx')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    target: 'es2022',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    nodePaths: [path.join(webRoot, 'node_modules')],
    logLevel: 'silent',
  });
  harnessJs = out.outputFiles[0]!.text;
});

/** Doc copy whose frame renders at `width` on the canvas, with auto height. */
function atWidth(doc: DesignDoc, frameId: string, width: number): DesignDoc {
  return {
    ...doc,
    frames: doc.frames.map((f) => (f.id === frameId ? { ...f, width, height: 'auto' } : f)),
  };
}

async function shootCanvas(page: Page, doc: DesignDoc, frameId: string, width: number) {
  await page.setViewportSize({ width, height: 3000 });
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body><div id="root"></div></body></html>`,
  );
  await page.evaluate((input) => (window.__PARITY__ = input), {
    doc: atWidth(doc, frameId, width),
    ds,
    frameId,
  });
  await page.addScriptTag({ content: harnessJs });
  await page.waitForFunction(() => window.__PARITY_READY__ === true);
  const frame = page.locator('[data-cd-frame-host] >> .cd-frame'); // pierces the shadow root
  await expect(frame).toBeVisible();
  return frame.screenshot({ animations: 'disabled' });
}

async function shootExport(page: Page, html: string, width: number) {
  await page.setViewportSize({ width, height: 3000 });
  await page.setContent(html, { waitUntil: 'load' });
  const frame = page.locator('.cd-frame').first();
  await expect(frame).toBeVisible();
  return frame.screenshot({ animations: 'disabled' });
}

/** Fraction of pixels differing beyond the per-channel tolerance (computed in the browser). */
async function diffRatio(page: Page, a: Buffer, b: Buffer): Promise<number> {
  await page.setContent('<!doctype html><html><body></body></html>');
  return page.evaluate(
    async ({ a, b, tol }) => {
      const load = (b64: string) =>
        new Promise<HTMLImageElement>((res, rej) => {
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = rej;
          img.src = `data:image/png;base64,${b64}`;
        });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      if (ia.width !== ib.width || Math.abs(ia.height - ib.height) > 1) return 1;
      const w = ia.width;
      const h = Math.min(ia.height, ib.height);
      const px = (img: HTMLImageElement) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, w, h).data;
      };
      const da = px(ia);
      const db = px(ib);
      let bad = 0;
      for (let i = 0; i < da.length; i += 4) {
        if (
          Math.abs(da[i]! - db[i]!) > tol ||
          Math.abs(da[i + 1]! - db[i + 1]!) > tol ||
          Math.abs(da[i + 2]! - db[i + 2]!) > tol ||
          Math.abs(da[i + 3]! - db[i + 3]!) > tol
        )
          bad++;
      }
      return bad / (w * h);
    },
    { a: a.toString('base64'), b: b.toString('base64'), tol: CHANNEL_TOLERANCE },
  );
}

for (const fx of FIXTURES) {
  for (const bp of BREAKPOINTS) {
    test(`exported HTML matches the canvas: ${fx.name} @ ${bp.name} (${bp.width}px)`, async ({
      page,
    }, info) => {
      const doc = fx.doc();
      const frameId = doc.frames[0]!.id;
      const canvas = await shootCanvas(page, doc, frameId, bp.width);
      const exported = await shootExport(
        page,
        exportHtml(doc, ds, { frameIds: [frameId] }).html,
        bp.width,
      );
      const ratio = await diffRatio(page, canvas, exported);
      if (ratio >= THRESHOLD) {
        await info.attach('canvas.png', { body: canvas, contentType: 'image/png' });
        await info.attach('export.png', { body: exported, contentType: 'image/png' });
      }
      expect(ratio, `differing pixel ratio at ${bp.width}px`).toBeLessThan(THRESHOLD);
    });
  }
}

test('ZIP index.html matches the canvas and works offline', async ({ page, context }) => {
  const doc = richDoc();
  const frameId = doc.frames[0]!.id;
  const { zip } = await buildExportZip(doc, ds);
  const index = new TextDecoder().decode((await readZipEntries(zip)).get('index.html'));
  await context.setOffline(true);
  await context.route('**/*', (route) => route.abort()); // nothing may be fetched
  const width = 1280;
  const canvas = await shootCanvas(page, doc, frameId, width);
  const exported = await shootExport(page, index, width);
  expect(await diffRatio(page, canvas, exported)).toBeLessThan(THRESHOLD);
});

test('breakpoint overrides really apply in both renderers (non-vacuous breakpoints)', async ({
  page,
}) => {
  const doc = richDoc(); // hero title is red from md up
  const frameId = doc.frames[0]!.id;
  const html = exportHtml(doc, ds, { frameIds: [frameId] }).html;
  const titleColor = async (canvas: boolean, width: number) => {
    if (canvas) {
      await shootCanvas(page, doc, frameId, width);
      return page
        .locator('[data-cd-frame-host] >> h1')
        .evaluate((el) => getComputedStyle(el).color);
    }
    await shootExport(page, html, width);
    return page.locator('h1').evaluate((el) => getComputedStyle(el).color);
  };
  for (const canvas of [true, false]) {
    expect(await titleColor(canvas, 390)).not.toBe('rgb(185, 28, 28)');
    expect(await titleColor(canvas, ds.breakpoints.md + 32)).toBe('rgb(185, 28, 28)');
  }
});

test('the diff detects real differences (guards against a vacuous pass)', async ({ page }) => {
  const doc = sampleLandingDoc();
  const frameId = doc.frames[0]!.id;
  const changed = applyOps(doc, [
    { op: 'setProps', id: 'n_herotitle1', patch: { text: 'A completely different headline' } },
  ]).doc;
  const canvas = await shootCanvas(page, doc, frameId, 1280);
  const exported = await shootExport(
    page,
    exportHtml(changed, ds, { frameIds: [frameId] }).html,
    1280,
  );
  expect(await diffRatio(page, canvas, exported)).toBeGreaterThan(THRESHOLD);
});
