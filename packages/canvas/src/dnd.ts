/**
 * Flow-first drag and drop (Story 3.4, SPEC D2). Dropping reorders within a flex/grid parent or
 * reparents into another container via moveNode, so the result is always valid flow CSS.
 * Free x/y placement is opt-in (positioning: 'absolute' + top/left).
 */
import {
  applyOps,
  LEAF_TYPES,
  type Breakpoint,
  type DesignDoc,
  type DocOp,
} from '@crunch/doc-model';
import type { Point, Rect } from './geometry';
import { ancestors } from './tree';

export interface Flow {
  /** Main axis: 'row' for flex rows and grids (row-major), 'column' for flex columns and blocks. */
  direction: 'row' | 'column';
}

export interface ChildBox {
  id: string;
  rect: Rect;
}

/**
 * Insertion index among `children` (in DOM order) for a pointer, along the container's flow.
 * Row flows wrap: children on rows above the pointer come before it.
 */
export function dropIndex(children: readonly ChildBox[], p: Point, flow: Flow): number {
  let i = 0;
  for (const c of children) {
    const r = c.rect;
    const before =
      flow.direction === 'column'
        ? r.y + r.height / 2 < p.y
        : r.y + r.height <= p.y || (r.y <= p.y && r.x + r.width / 2 < p.x);
    if (before) i++;
    else if (flow.direction === 'column' || r.y > p.y) break;
  }
  return i;
}

/** The insertion line for an index: a thin rect between siblings, or inside an empty container. */
export function dropLine(
  children: readonly ChildBox[],
  index: number,
  container: Rect,
  flow: Flow,
  thickness = 2,
): Rect {
  const t = thickness;
  if (!children.length) {
    return {
      x: container.x + 4,
      y: container.y + 4,
      width: Math.max(t, container.width - 8),
      height: t,
    };
  }
  const at = children[index];
  const prev = children[index - 1];
  if (flow.direction === 'column') {
    const y = at
      ? prev
        ? (prev.rect.y + prev.rect.height + at.rect.y) / 2
        : at.rect.y
      : prev!.rect.y + prev!.rect.height;
    const ref = (at ?? prev)!.rect;
    return { x: ref.x, y: y - t / 2, width: ref.width, height: t };
  }
  // Row: a vertical line before `at`, or after the last child.
  const sameRow = at && prev && Math.abs(at.rect.y - prev.rect.y) < 1;
  const x = at
    ? sameRow
      ? (prev!.rect.x + prev!.rect.width + at.rect.x) / 2
      : at.rect.x
    : prev!.rect.x + prev!.rect.width;
  const ref = (at ?? prev)!.rect;
  return { x: x - t / 2, y: ref.y, width: t, height: ref.height };
}

/** Every node id inside the given subtrees (roots included). */
export function subtreeSet(doc: DesignDoc, roots: readonly string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    const n = doc.nodes[id];
    if (!n) continue;
    out.add(id);
    stack.push(...n.children);
  }
  return out;
}

/** Can `ids` be dropped into `parentId`? (A container, not inside what's being dragged.) */
export function canDropInto(doc: DesignDoc, ids: readonly string[], parentId: string): boolean {
  const p = doc.nodes[parentId];
  if (!p || LEAF_TYPES.has(p.type)) return false;
  if (ids.includes(parentId)) return false;
  return !ancestors(doc, parentId).some((a) => ids.includes(a));
}

/**
 * moveNode ops that put `ids` (in order) into `parentId` before `beforeId` (or at the end when
 * null). `beforeId` is a sibling that isn't being moved. Returns [] for a no-op.
 */
export function moveOps(
  doc: DesignDoc,
  ids: readonly string[],
  parentId: string,
  beforeId: string | null,
): DocOp[] {
  if (!canDropInto(doc, ids, parentId)) return [];
  let d = doc;
  const ops: DocOp[] = [];
  for (const id of ids) {
    const n = d.nodes[id];
    if (!n?.parentId) continue;
    const without = d.nodes[parentId]!.children.filter((c) => c !== id);
    const index = beforeId ? without.indexOf(beforeId) : without.length;
    if (index < 0) return [];
    const fromIndex = d.nodes[n.parentId]!.children.indexOf(id);
    if (n.parentId === parentId && fromIndex === index) continue;
    const op: DocOp = { op: 'moveNode', id, parentId, index };
    d = applyOps(d, [op]).doc;
    ops.push(op);
  }
  // Keep the moved nodes contiguous and in order: each later node goes right after the previous one.
  return ops;
}

/**
 * Ops for free placement at `left`/`top` (px, relative to the nearest positioned ancestor) at a
 * breakpoint. Turns a flow node absolute, pinning its width so it keeps its size when it leaves
 * the flow.
 */
export function absolutePlacementOps(
  doc: DesignDoc,
  id: string,
  bp: Breakpoint,
  pos: { left: number; top: number },
  size?: { width: number },
): DocOp[] {
  const n = doc.nodes[id];
  if (!n?.parentId) return [];
  const ops: DocOp[] = [];
  if (n.positioning !== 'absolute') {
    ops.push({ op: 'setNodeMeta', id, patch: { positioning: 'absolute' } });
    const w = n.style[bp]?.width ?? n.style.base?.width;
    if (size && (w === undefined || w === 'fill' || w === 'auto')) {
      ops.push({
        op: 'setStyle',
        id,
        breakpoint: bp,
        prop: 'width',
        value: Math.round(size.width),
      });
    }
  }
  ops.push({ op: 'setStyle', id, breakpoint: bp, prop: 'left', value: Math.round(pos.left) });
  ops.push({ op: 'setStyle', id, breakpoint: bp, prop: 'top', value: Math.round(pos.top) });
  return ops;
}

/** Ops that return an absolute node to the flow, clearing its insets at every breakpoint. */
export function toFlowOps(doc: DesignDoc, id: string): DocOp[] {
  const n = doc.nodes[id];
  if (!n || n.positioning === 'flow') return [];
  const ops: DocOp[] = [{ op: 'setNodeMeta', id, patch: { positioning: 'flow' } }];
  for (const bp of ['base', 'md', 'lg'] as const)
    for (const prop of ['top', 'right', 'bottom', 'left'] as const)
      if (n.style[bp]?.[prop] !== undefined)
        ops.push({ op: 'setStyle', id, breakpoint: bp, prop, value: null });
  return ops;
}
