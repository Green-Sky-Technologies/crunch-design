/**
 * Insert tools (edit panel tool row): node builders for text, box, rectangle, ellipse, line,
 * image, vector (arrow, pencil) and component instances. Flow-positioned by default (SPEC D2);
 * free placement is opt-in and writes top/left like an absolute drag.
 */
import {
  newId,
  type Breakpoint,
  type DesignSystemSpec,
  type DocOp,
  type Node,
  type StyleProps,
  type TokenRef,
} from '@crunch/doc-model';
import type { Point } from './geometry';

export type InsertTool =
  'text' | 'box' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'pencil' | 'image' | 'component';

export type Tool = 'select' | InsertTool;

/** Default size when a tool is clicked rather than dragged. */
export const DEFAULT_SIZES: Record<InsertTool, { width: number; height: number } | null> = {
  text: null,
  box: { width: 240, height: 160 },
  rect: { width: 160, height: 100 },
  ellipse: { width: 120, height: 120 },
  line: { width: 160, height: 1 },
  arrow: { width: 160, height: 24 },
  pencil: null,
  image: { width: 320, height: 200 },
  component: null,
};

/** Tools that draw a vector, which is always freely placed where it was drawn. */
export const VECTOR_TOOLS: ReadonlySet<InsertTool> = new Set(['arrow', 'pencil']);

export interface InsertSpec {
  tool: InsertTool;
  /** Size in CSS px, from a drag; omitted for a click (tool defaults). */
  size?: { width: number; height: number };
  /** Free placement (top/left px in the parent); omitted for flow. */
  at?: { left: number; top: number };
  /** image: src. */
  src?: string;
  /** component: design-system component id. */
  componentId?: string;
  /** arrow: start/end; pencil: the stroke. Points are relative to the drawn box's top-left. */
  points?: Point[];
}

/** A token ref when the design system defines it, else the literal fallback. */
function tok(ds: DesignSystemSpec, path: string, fallback: string): TokenRef | string {
  return ds.tokens[path] ? { token: path } : fallback;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function vectorSvg(tool: 'arrow' | 'pencil', w: number, h: number, pts: Point[]): string {
  const width = Math.max(1, Math.round(w));
  const height = Math.max(1, Math.round(h));
  const head = (a: Point, b: Point) => {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const len = 10;
    const p = (d: number) =>
      `${r1(b.x - len * Math.cos(ang + d))},${r1(b.y - len * Math.sin(ang + d))}`;
    return `<polyline points="${p(0.5)} ${r1(b.x)},${r1(b.y)} ${p(-0.5)}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  };
  let body: string;
  if (tool === 'arrow') {
    const a = pts[0] ?? { x: 0, y: height / 2 };
    const b = pts[pts.length - 1] ?? { x: width, y: height / 2 };
    body =
      `<line x1="${r1(a.x)}" y1="${r1(a.y)}" x2="${r1(b.x)}" y2="${r1(b.y)}" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>` +
      head(a, b);
  } else {
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${r1(p.x)} ${r1(p.y)}`).join(' ') || 'M0 0';
    body = `<path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
}

/** Drop points closer than `tolerance` px to the previous kept point (pencil strokes). */
export function simplifyStroke(points: readonly Point[], tolerance = 2): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= tolerance) out.push(p);
  }
  const end = points[points.length - 1];
  if (end && out[out.length - 1] !== end) out.push(end);
  return out.slice(0, 2000);
}

/** The node a tool creates, parented to `parentId`. Returns null if the spec is incomplete. */
export function buildInsertNode(
  spec: InsertSpec,
  parentId: string,
  ds: DesignSystemSpec,
): Node | null {
  const id = newId('n');
  const size = spec.size ?? DEFAULT_SIZES[spec.tool] ?? undefined;
  const base = {
    id,
    parentId,
    children: [] as string[],
    positioning: spec.at ? ('absolute' as const) : ('flow' as const),
  };
  const sized: StyleProps = size
    ? { width: Math.max(1, Math.round(size.width)), height: Math.max(1, Math.round(size.height)) }
    : {};
  const placed: StyleProps = spec.at
    ? { left: Math.round(spec.at.left), top: Math.round(spec.at.top) }
    : {};
  const box = (name: string, style: StyleProps): Node => ({
    ...base,
    type: 'box',
    tag: 'div',
    name,
    props: {},
    style: { base: { ...sized, ...placed, flexShrink: 0, ...style } },
  });

  switch (spec.tool) {
    case 'text':
      return {
        ...base,
        type: 'text',
        tag: 'p',
        props: { text: 'Text' },
        style: {
          base: {
            ...(spec.size ? { width: Math.max(1, Math.round(spec.size.width)) } : {}),
            ...placed,
            color: tok(ds, 'color.text', '#18181b'),
          },
        },
      };
    case 'box':
      return {
        ...base,
        type: 'box',
        tag: 'div',
        props: {},
        style: {
          base: {
            ...sized,
            ...placed,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            paddingTop: 16,
            paddingRight: 16,
            paddingBottom: 16,
            paddingLeft: 16,
            flexShrink: 0,
            backgroundColor: tok(ds, 'color.surface', '#f4f4f5'),
          },
        },
      };
    case 'rect':
      return box('Rectangle', { backgroundColor: tok(ds, 'color.border', '#d4d4d8') });
    case 'ellipse':
      return box('Ellipse', {
        backgroundColor: tok(ds, 'color.border', '#d4d4d8'),
        borderRadius: '50%',
      });
    case 'line':
      return box('Line', {
        height: 1,
        backgroundColor: tok(ds, 'color.text', '#18181b'),
      });
    case 'image':
      if (!spec.src) return null;
      return {
        ...base,
        type: 'image',
        props: { src: spec.src, alt: '' },
        style: { base: { ...sized, ...placed, objectFit: 'cover', flexShrink: 0 } },
      };
    case 'arrow':
    case 'pencil': {
      const w = size?.width ?? 1;
      const h = size?.height ?? 1;
      return {
        ...base,
        type: 'svg',
        name: spec.tool === 'arrow' ? 'Arrow' : 'Drawing',
        props: { svg: vectorSvg(spec.tool, w, h, spec.points ?? []) },
        style: {
          base: { ...sized, ...placed, flexShrink: 0, color: tok(ds, 'color.text', '#18181b') },
        },
      };
    }
    case 'component': {
      const def = spec.componentId ? ds.components[spec.componentId] : undefined;
      if (!def) return null;
      return {
        ...base,
        type: 'instance',
        componentRef: { componentId: def.id, variant: {} },
        props: { values: {} },
        style: spec.at ? { base: placed } : {},
      };
    }
  }
}

/** Ops that insert a tool's node into `parentId` at `index`. */
export function insertNodeOps(
  spec: InsertSpec,
  parentId: string,
  index: number,
  ds: DesignSystemSpec,
): { ops: DocOp[]; id: string } | null {
  const node = buildInsertNode(spec, parentId, ds);
  if (!node) return null;
  return { ops: [{ op: 'insertSubtree', parentId, index, nodes: [node] }], id: node.id };
}

/** The breakpoint a new node's styles are written at: always base, so it shows everywhere. */
export const INSERT_BREAKPOINT: Breakpoint = 'base';
