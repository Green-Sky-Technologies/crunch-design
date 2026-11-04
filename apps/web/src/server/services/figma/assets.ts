/**
 * Images sent by the plugin during import (Story 8.3) arrive as base64 data URLs. DesignDoc image
 * sources are capped at 4 KB, so real images are decoded, validated (raster types only, magic
 * bytes must match the declared type, size cap), stored in asset storage (Vercel Blob) and
 * referenced by their https URL. Each stored file is recorded in `assets` (kind 'figma').
 *
 * The uploader is injectable; without storage configured (no BLOB_READ_WRITE_TOKEN), images
 * that don't fit inline become placeholders with a clear report entry.
 */
import { and, assets, eq, type Db } from '@crunch/db';
import { safeImageSrc } from '@crunch/doc-model';
import type { ReportItem } from '@crunch/figma-convert';
import { createHash } from 'node:crypto';
import type { Actor } from '../types';

export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;

export type ImageUploader = (
  pathname: string,
  bytes: Buffer,
  contentType: string,
) => Promise<{ url: string; pathname: string }>;

const TYPES = {
  'image/png': {
    ext: 'png',
    magic: (b: Buffer) =>
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  'image/jpeg': {
    ext: 'jpg',
    magic: (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  'image/gif': {
    ext: 'gif',
    magic: (b: Buffer) => /^GIF8[79]a/.test(b.subarray(0, 6).toString('latin1')),
  },
  'image/webp': {
    ext: 'webp',
    magic: (b: Buffer) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  'image/avif': {
    ext: 'avif',
    magic: (b: Buffer) => b.subarray(4, 12).toString('latin1') === 'ftypavif',
  },
} as const;
type RasterType = keyof typeof TYPES;

export interface DecodedImage {
  bytes: Buffer;
  contentType: RasterType;
  ext: string;
  sha256: string;
}

/** Decode a raster base64 data URL, or explain why it's rejected. */
export function decodeRasterDataUrl(src: string): DecodedImage | { error: string } {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(src);
  if (!m) return { error: 'not a base64 image data URL' };
  const type = m[1] as RasterType;
  const def = Object.prototype.hasOwnProperty.call(TYPES, type) ? TYPES[type] : undefined;
  if (!def) return { error: `${m[1]} is not an allowed raster type` };
  if ((m[2]!.length * 3) / 4 > MAX_IMAGE_BYTES + 3) return { error: 'image is too large' };
  const bytes = Buffer.from(m[2]!, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) return { error: 'image is too large' };
  if (!def.magic(bytes)) return { error: `contents are not a ${type} image` };
  return {
    bytes,
    contentType: type,
    ext: def.ext,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/** Vercel Blob uploader when storage is configured, else null. */
export function defaultImageUploader(): ImageUploader | null {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  return async (pathname, bytes, contentType) => {
    const { put } = await import('@vercel/blob');
    const r = await put(pathname, bytes, { access: 'public', contentType, addRandomSuffix: true });
    return { url: r.url, pathname: r.pathname };
  };
}

/**
 * Resolve import image refs to sources a DesignDoc accepts: https URLs pass through, data URLs are
 * stored (deduplicated by content hash per workspace). Anything else is dropped with a report item.
 */
export async function storeImportImages(
  db: Db,
  actor: Actor,
  projectId: string,
  images: Record<string, string>,
  uploader: ImageUploader | null,
): Promise<{ resolved: Record<string, string>; report: ReportItem[] }> {
  const resolved: Record<string, string> = {};
  const report: ReportItem[] = [];
  let noStorage = 0;
  for (const [ref, src] of Object.entries(images)) {
    if (/^https:\/\//.test(src)) {
      if (safeImageSrc.safeParse(src).success) resolved[ref] = src;
      continue;
    }
    const img = decodeRasterDataUrl(src);
    if ('error' in img) {
      report.push({
        severity: 'warning',
        subject: 'image',
        message: `Image rejected: ${img.error}`,
      });
      continue;
    }
    if (!uploader) {
      // Small images can stay inline; larger ones need storage.
      if (safeImageSrc.safeParse(src).success) resolved[ref] = src;
      else noStorage++;
      continue;
    }
    const [existing] = await db
      .select({ url: assets.blobUrl })
      .from(assets)
      .where(
        and(
          eq(assets.workspaceId, actor.workspace.id),
          eq(assets.kind, 'figma'),
          eq(assets.sha256, img.sha256),
        ),
      )
      .limit(1);
    if (existing) {
      resolved[ref] = existing.url;
      continue;
    }
    try {
      const pathname = `workspaces/${actor.workspace.id}/figma/${img.sha256}.${img.ext}`;
      const up = await uploader(pathname, img.bytes, img.contentType);
      if (!safeImageSrc.safeParse(up.url).success)
        throw new Error('storage returned an unusable URL');
      await db.insert(assets).values({
        workspaceId: actor.workspace.id,
        projectId,
        kind: 'figma',
        blobUrl: up.url,
        pathname: up.pathname,
        contentType: img.contentType,
        sizeBytes: img.bytes.length,
        sha256: img.sha256,
        meta: { source: 'figma-import', imageRef: ref.slice(0, 200) },
        createdBy: actor.userId,
      });
      resolved[ref] = up.url;
    } catch (e) {
      console.error('[figma] image upload failed', e instanceof Error ? e.name : typeof e);
      report.push({
        severity: 'warning',
        subject: 'image',
        message: 'Image upload failed; replaced by a placeholder',
      });
    }
  }
  if (noStorage)
    report.push({
      severity: 'warning',
      subject: 'image',
      message: `${noStorage} image(s) need asset storage (BLOB_READ_WRITE_TOKEN is not configured); replaced by placeholders`,
      count: noStorage,
    });
  return { resolved, report };
}
