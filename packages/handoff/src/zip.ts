/**
 * ZIP export (Story 7.1): index.html with every frame, one page per frame, bundled images
 * (when an asset fetcher is supplied), and a README. Byte-for-byte deterministic for the same
 * inputs (fixed entry dates, sorted entries), so exports can be diffed and cached.
 */
import { createHash } from 'node:crypto';
import type { DesignDoc, DesignSystemSpec } from '@crunch/doc-model';
import JSZip from 'jszip';
import {
  collectImageSources,
  extensionFor,
  frameNodeIds,
  rewriteImageSources,
  type AssetFetcher,
} from './assets';
import { exportHtml, resolveFrameIds, uniqueSlugs, type HtmlExportOptions } from './html';

export interface ZipExportOptions extends HtmlExportOptions {
  /** Fetch images into the ZIP so it works offline. Without it images stay remote. */
  fetchAsset?: AssetFetcher;
  /** Extra files to include (e.g. handoff.json). Paths are relative to the ZIP root. */
  extraFiles?: Record<string, string | Uint8Array>;
  /** Maximum total bytes of bundled assets (default 50 MB); further assets stay remote. */
  maxAssetBytes?: number;
  /** Maximum number of images fetched (default 100); further images stay remote. */
  maxAssets?: number;
  /** Overall time budget for fetching images (default 30 s); then the rest stay remote. */
  assetTimeBudgetMs?: number;
}

export const ZIP_ASSET_DEFAULTS = {
  maxAssetBytes: 50 * 1024 * 1024,
  maxAssets: 100,
  assetTimeBudgetMs: 30_000,
} as const;

export interface ZipExportResult {
  zip: Uint8Array;
  files: string[];
  warnings: string[];
}

const FIXED_DATE = new Date(Date.UTC(1980, 0, 1));

function readme(title: string, pages: { file: string; name: string }[], remote: string[]) {
  const lines = [
    `${title}`,
    '',
    'Exported from CrunchDesign as standalone HTML (no JavaScript, inline CSS).',
    'Open index.html in any modern browser. Pages are responsive: breakpoints follow the',
    'page width, exactly as the frame width does on the canvas.',
    '',
    'Files:',
    '  index.html  all frames',
    ...pages.map((p) => `  ${p.file}  ${p.name}`),
  ];
  if (remote.length)
    lines.push(
      '',
      'These images are referenced remotely and need a network connection:',
      ...remote.map((r) => `  ${r}`),
    );
  return `${lines.join('\n')}\n`;
}

export async function buildExportZip(
  doc: DesignDoc,
  ds: DesignSystemSpec,
  opts: ZipExportOptions = {},
): Promise<ZipExportResult> {
  const frameIds = resolveFrameIds(doc, opts.frameIds);
  const warnings: string[] = [];
  const zip = new JSZip();
  const add = (path: string, data: string | Uint8Array) =>
    zip.file(path, data, {
      date: FIXED_DATE,
      createFolders: false,
      binary: typeof data !== 'string',
    });

  // Bundle images, page-relative paths are fixed up per page depth below.
  const sources = collectImageSources(doc, frameNodeIds(doc, frameIds));
  const bundled = new Map<string, string>(); // src -> assets/<hash>.<ext>
  const remote: string[] = [];
  let total = 0;
  let attempts = 0;
  const cap = opts.maxAssetBytes ?? ZIP_ASSET_DEFAULTS.maxAssetBytes;
  const maxAssets = opts.maxAssets ?? ZIP_ASSET_DEFAULTS.maxAssets;
  const budget = AbortSignal.timeout(
    opts.assetTimeBudgetMs ?? ZIP_ASSET_DEFAULTS.assetTimeBudgetMs,
  );
  for (const src of sources) {
    let asset = null;
    // Check every budget before fetching, not after: count, time, and remaining bytes.
    if (opts.fetchAsset && attempts < maxAssets && !budget.aborted && total < cap) {
      attempts++;
      try {
        asset = await opts.fetchAsset(src, { signal: budget, maxBytes: cap - total });
      } catch {
        asset = null;
      }
    }
    const ext = asset ? extensionFor(asset.contentType) : null;
    if (!asset || !ext || total + asset.bytes.byteLength > cap) {
      remote.push(src);
      continue;
    }
    total += asset.bytes.byteLength;
    const hash = createHash('sha256').update(asset.bytes).digest('hex').slice(0, 16);
    const path = `assets/${hash}.${ext}`;
    bundled.set(src, path);
    add(path, asset.bytes);
  }
  if (remote.length && opts.fetchAsset)
    warnings.push(`${remote.length} image(s) could not be bundled and stay remote`);

  const withPrefix = (prefix: string) =>
    rewriteImageSources(doc, new Map([...bundled].map(([k, v]) => [k, prefix + v])));

  const index = exportHtml(withPrefix(''), ds, { ...opts, frameIds });
  warnings.push(...index.warnings);
  add('index.html', index.html);

  const frames = frameIds.map((id) => doc.frames.find((f) => f.id === id)!);
  const slugs = uniqueSlugs(frames.map((f) => f.name));
  const nested = withPrefix('../');
  const pages = frames.map((f, i) => {
    const file = `frames/${slugs[i]}.html`;
    add(file, exportHtml(nested, ds, { frameIds: [f.id], title: f.name, theme: opts.theme }).html);
    return { file, name: f.name };
  });

  add('README.txt', readme(opts.title ?? frames[0]?.name ?? 'Design', pages, remote));
  for (const [path, data] of Object.entries(opts.extraFiles ?? {})) {
    if (path.includes('..') || path.startsWith('/')) throw new Error(`Invalid path ${path}`);
    add(path, data);
  }

  const files = Object.keys(zip.files)
    .filter((p) => !zip.files[p]!.dir)
    .sort();
  const out = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'UNIX',
  });
  return { zip: out, files, warnings: [...new Set(warnings)] };
}

/** Read a ZIP back (tests, codegen consumers): path -> bytes, sorted by path. */
export async function readZipEntries(data: Uint8Array): Promise<Map<string, Uint8Array>> {
  const zip = await JSZip.loadAsync(data);
  const out = new Map<string, Uint8Array>();
  for (const path of Object.keys(zip.files).sort()) {
    const f = zip.files[path]!;
    if (!f.dir) out.set(path, await f.async('uint8array'));
  }
  return out;
}
