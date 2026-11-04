/**
 * Standalone HTML export (Story 7.1). Deterministic (no LLM): the static renderer's output with
 * annotations stripped, frames fluid so the page responds to the viewport exactly like the
 * canvas frame responds to its width (breakpoints are container queries on the frame).
 */
import type { DesignDoc, DesignSystemSpec } from '@crunch/doc-model';
import { renderDocumentHtml } from '@crunch/renderer';

export interface HtmlExportOptions {
  /** Subset of frames (default: all, in document order). */
  frameIds?: string[];
  /** Document title (default: the first frame's name). */
  title?: string;
  theme?: string;
}

export class ExportError extends Error {
  override name = 'ExportError';
}

export function resolveFrameIds(doc: DesignDoc, frameIds?: string[]): string[] {
  if (!frameIds) return doc.frames.map((f) => f.id);
  const known = new Set(doc.frames.map((f) => f.id));
  const unknown = frameIds.filter((id) => !known.has(id));
  if (unknown.length) throw new ExportError(`Unknown frame: ${unknown[0]}`);
  return [...new Set(frameIds)];
}

/** One self-contained HTML page (inline CSS, no scripts, no annotations). */
export function exportHtml(
  doc: DesignDoc,
  ds: DesignSystemSpec,
  opts: HtmlExportOptions = {},
): { html: string; warnings: string[] } {
  const frameIds = resolveFrameIds(doc, opts.frameIds);
  if (!frameIds.length) throw new ExportError('Nothing to export: the design has no frames');
  return renderDocumentHtml(doc, ds, {
    frameIds,
    title: opts.title,
    theme: opts.theme,
    fluid: true,
    annotate: false,
  });
}

/** File-system-safe, lowercase slug; never empty. */
export function slugify(name: string, fallback = 'frame'): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || fallback;
}

/** Unique slugs for a list of names (adds -2, -3… on collisions). */
export function uniqueSlugs(names: string[], fallback = 'frame'): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const base = slugify(n, fallback);
    const k = (seen.get(base) ?? 0) + 1;
    seen.set(base, k);
    return k === 1 ? base : `${base}-${k}`;
  });
}
