/**
 * Static HTML renderer (Story 2.3 parity; used by HTML/ZIP export 7.1, share pages 6.3,
 * screenshots and the handoff bundle 7.2). Same describe() and per-node CSS as the DOM
 * renderer, so the markup and rules are identical.
 */
import type { DesignDoc, DesignSystemSpec } from '@crunch/doc-model';
import { rnodeCss, sharedCss, type RenderContext } from './core';
import { layoutOf, ROOT_LAYOUT, type ParentLayouts } from './css';
import { DEFAULT_OPTIONS, describe, rnodeFor, type RenderOptions, type RNode } from './describe';

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function open(tag: string, attrs: Record<string, string>) {
  return `<${tag}${Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${escAttr(v)}"`)
    .join('')}>`;
}

interface Out {
  html: string[];
  css: string[];
}

function emit(r: RNode, parents: ParentLayouts, ctx: RenderContext, out: Out) {
  out.css.push(rnodeCss(r, parents, ctx));
  const d = describe(r, ctx.options);
  out.html.push(open(d.tag, d.attrs));
  if (d.void) return;
  if (d.svgHtml !== undefined) out.html.push(d.svgHtml);
  else if (d.text !== undefined) out.html.push(escText(d.text));
  else {
    const childParents = layoutOf(r.style);
    if (r.children) for (const c of r.children) emit(c, childParents, ctx, out);
    else
      for (const cid of r.node.children) {
        const child = ctx.doc.nodes[cid];
        if (child) emit(rnodeFor(child, ctx.ds), childParents, ctx, out);
      }
  }
  out.html.push(`</${d.tag}>`);
}

export interface StaticFrame {
  /** `<div class="cd-frame" …>…</div>` */
  html: string;
  /** Per-node rules for this frame (shared token/reset CSS is separate). */
  css: string;
  frameCss: string;
}

export function renderFrameStatic(
  doc: DesignDoc,
  ds: DesignSystemSpec,
  frameId: string,
  options: Partial<RenderOptions> & { fluid?: boolean; theme?: string } = {},
): StaticFrame {
  const frame = doc.frames.find((f) => f.id === frameId);
  if (!frame) throw new Error(`Frame ${frameId} not found`);
  const ctx: RenderContext = { doc, ds, options: { ...DEFAULT_OPTIONS, ...options } };
  const out: Out = { html: [], css: [] };
  const root = doc.nodes[frame.rootNodeId];
  if (root) emit(rnodeFor(root, ds), ROOT_LAYOUT, ctx, out);
  const attrs: Record<string, string> = { class: 'cd-frame', 'data-frame': frame.id };
  if (options.theme) attrs['data-theme'] = options.theme;
  const height = frame.height === 'auto' ? '' : `min-height:${frame.height}px;`;
  return {
    html: `${open('div', attrs)}${out.html.join('')}</div>`,
    css: out.css.filter(Boolean).join('\n'),
    frameCss: `.cd-frame[data-frame="${frame.id}"]{width:${options.fluid ? '100%' : `${frame.width}px`};${height}}`,
  };
}

export interface StaticDocumentOptions {
  title?: string;
  frameIds?: string[];
  theme?: string;
  /** Frames fill the page width (exports) instead of their canvas width. Default true. */
  fluid?: boolean;
  /** Keep data-cd-* annotations (share viewer needs them for comments). Default false. */
  annotate?: boolean;
}

/** A complete standalone HTML page for one or more frames. */
export function renderDocumentHtml(
  doc: DesignDoc,
  ds: DesignSystemSpec,
  opts: StaticDocumentOptions = {},
): { html: string; warnings: string[] } {
  const fluid = opts.fluid ?? true;
  const options: RenderOptions = { annotate: opts.annotate ?? false, showHidden: false };
  const ids = opts.frameIds ?? doc.frames.map((f) => f.id);
  const frames = ids.map((id) =>
    renderFrameStatic(doc, ds, id, {
      ...options,
      fluid,
      ...(opts.theme ? { theme: opts.theme } : {}),
    }),
  );
  const shared = sharedCss({ doc, ds, options });
  const css = [shared.css, ...frames.map((f) => `${f.frameCss}\n${f.css}`)].join('\n');
  const title = escText(opts.title ?? doc.frames.find((f) => f.id === ids[0])?.name ?? 'Design');
  const body = frames.map((f) => f.html).join(fluid ? '' : '\n');
  const html =
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${title}</title>\n` +
    `<style>\nbody{margin:0}\n${css}\n</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
  return { html, warnings: shared.warnings };
}
