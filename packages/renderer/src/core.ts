/**
 * Shared render core: per-node CSS for RNodes, frame-level CSS, and context. The DOM renderer
 * calls these per node (incrementally); the static renderer walks the whole tree.
 */
import type { DesignDoc, DesignSystemSpec, Frame } from '@crunch/doc-model';
import { baseCss, nodeRules, type BreakpointWidths, type ParentLayouts } from './css';
import { classFor, type RenderOptions, type RNode } from './describe';
import { compileTokens, tokensToCss } from './tokens';

export interface RenderContext {
  doc: DesignDoc;
  ds: DesignSystemSpec;
  options: RenderOptions;
}

export function breakpointsOf(ds: DesignSystemSpec): BreakpointWidths {
  return { md: ds.breakpoints.md, lg: ds.breakpoints.lg };
}

export function rnodeCss(r: RNode, parents: ParentLayouts, ctx: RenderContext): string {
  return nodeRules(
    `.${classFor(r.key)}`,
    r.style,
    parents,
    {
      absolute: r.node.positioning === 'absolute',
      isBox: r.node.type === 'box',
      hidden: r.hidden && !ctx.options.showHidden,
    },
    breakpointsOf(ctx.ds),
  );
}

/** Stylesheet text shared by every frame of a doc: reset + tokens (with doc overrides). */
export function sharedCss(ctx: RenderContext): { css: string; warnings: string[] } {
  const compiled = compileTokens(ctx.ds, ctx.doc.tokenOverrides);
  const extra = ctx.options.showHidden ? '\n.cd-frame [data-cd-hidden]{opacity:.35;}' : '';
  return {
    css: `${baseCss()}\n${tokensToCss(compiled, '.cd-frame')}${extra}`,
    warnings: compiled.warnings,
  };
}

/** Frame wrapper element CSS: fixed width on the canvas, fluid in exports. */
export function frameWrapperStyle(frame: Frame, fluid: boolean): string {
  const h = frame.height === 'auto' ? '' : `min-height:${frame.height}px;`;
  return fluid ? `width:100%;${h}` : `width:${frame.width}px;${h}`;
}
