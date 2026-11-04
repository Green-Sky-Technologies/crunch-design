/**
 * Smart guides (Story 3.5): snap a moving or resizing rect's edges and centres to its siblings'
 * and parent's, within a threshold, and report the guide lines to draw. World coordinates.
 */
import type { Rect } from './geometry';
import type { Handle } from './sizing';

type Edge = 'min' | 'mid' | 'max';

export interface SnapResult {
  rect: Rect;
  /** Guide lines as thin world rects (vertical for x snaps, horizontal for y snaps). */
  lines: Rect[];
}

const edgesOf = (r: Rect, axis: 'x' | 'y'): Record<Edge, number> => {
  const p = axis === 'x' ? r.x : r.y;
  const s = axis === 'x' ? r.width : r.height;
  return { min: p, mid: p + s / 2, max: p + s };
};

function bestSnap(
  moving: Rect,
  edges: Edge[],
  others: readonly Rect[],
  axis: 'x' | 'y',
  threshold: number,
): { edge: Edge; delta: number; at: number } | null {
  const mine = edgesOf(moving, axis);
  let best: { edge: Edge; delta: number; at: number } | null = null;
  for (const o of others) {
    const theirs = edgesOf(o, axis);
    for (const e of edges)
      for (const t of [theirs.min, theirs.mid, theirs.max]) {
        const d = t - mine[e];
        if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.delta)))
          best = { edge: e, delta: d, at: t };
      }
  }
  return best;
}

function guideLines(r: Rect, others: readonly Rect[], axis: 'x' | 'y', at: number): Rect[] {
  const span = [
    r,
    ...others.filter((o) => Object.values(edgesOf(o, axis)).some((v) => Math.abs(v - at) < 0.5)),
  ];
  if (axis === 'x') {
    const y0 = Math.min(...span.map((s) => s.y));
    const y1 = Math.max(...span.map((s) => s.y + s.height));
    return [{ x: at, y: y0, width: 0, height: y1 - y0 }];
  }
  const x0 = Math.min(...span.map((s) => s.x));
  const x1 = Math.max(...span.map((s) => s.x + s.width));
  return [{ x: x0, y: at, width: x1 - x0, height: 0 }];
}

/** Snap a rect being moved: any of its edges or centre may align. */
export function snapMoveRect(moving: Rect, others: readonly Rect[], threshold: number): SnapResult {
  const all: Edge[] = ['min', 'mid', 'max'];
  const sx = bestSnap(moving, all, others, 'x', threshold);
  const sy = bestSnap(moving, all, others, 'y', threshold);
  const rect = { ...moving, x: moving.x + (sx?.delta ?? 0), y: moving.y + (sy?.delta ?? 0) };
  const lines = [
    ...(sx ? guideLines(rect, others, 'x', sx.at) : []),
    ...(sy ? guideLines(rect, others, 'y', sy.at) : []),
  ];
  return { rect, lines };
}

/** Snap a rect being resized: only the edges the handle moves can align. */
export function snapResizeRect(
  resized: Rect,
  handle: Handle,
  others: readonly Rect[],
  threshold: number,
): SnapResult {
  const rect = { ...resized };
  const lines: Rect[] = [];
  const xEdge: Edge | null = handle.includes('e') ? 'max' : handle.includes('w') ? 'min' : null;
  const yEdge: Edge | null = handle.includes('s') ? 'max' : handle.includes('n') ? 'min' : null;
  if (xEdge) {
    const s = bestSnap(rect, [xEdge], others, 'x', threshold);
    if (s) {
      if (xEdge === 'max') rect.width += s.delta;
      else {
        rect.x += s.delta;
        rect.width -= s.delta;
      }
      lines.push(...guideLines(rect, others, 'x', s.at));
    }
  }
  if (yEdge) {
    const s = bestSnap(rect, [yEdge], others, 'y', threshold);
    if (s) {
      if (yEdge === 'max') rect.height += s.delta;
      else {
        rect.y += s.delta;
        rect.height -= s.delta;
      }
      lines.push(...guideLines(rect, others, 'y', s.at));
    }
  }
  return { rect, lines };
}

export interface Distance {
  /** The gap as a thin world rect (horizontal or vertical). */
  line: Rect;
  /** Gap size in px. */
  value: number;
}

const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;
const containsRect = (o: Rect, r: Rect) =>
  o.x <= r.x && o.y <= r.y && o.x + o.width >= r.x + r.width && o.y + o.height >= r.y + r.height;

/**
 * Spacing guides (Story 3.5): the gap from a rect to its nearest neighbour on each side (among
 * rects that overlap it on the other axis), so you can see and match distances while placing or
 * resizing. Containers that enclose the rect (its parent) are ignored.
 */
export function spacingGuides(r: Rect, others: readonly Rect[]): Distance[] {
  const out: Distance[] = [];
  const near = (pick: (o: Rect) => number | null): [Rect, number] | null => {
    let best: [Rect, number] | null = null;
    for (const o of others) {
      if (containsRect(o, r)) continue;
      const gap = pick(o);
      if (gap !== null && gap >= 0 && (!best || gap < best[1])) best = [o, gap];
    }
    return best;
  };
  const vOverlap = (o: Rect) => overlaps(o.y, o.y + o.height, r.y, r.y + r.height);
  const hOverlap = (o: Rect) => overlaps(o.x, o.x + o.width, r.x, r.x + r.width);
  const midY = (o: Rect) => (Math.max(o.y, r.y) + Math.min(o.y + o.height, r.y + r.height)) / 2;
  const midX = (o: Rect) => (Math.max(o.x, r.x) + Math.min(o.x + o.width, r.x + r.width)) / 2;

  const left = near((o) => (vOverlap(o) ? r.x - (o.x + o.width) : null));
  if (left)
    out.push({
      line: { x: r.x - left[1], y: midY(left[0]), width: left[1], height: 0 },
      value: left[1],
    });
  const right = near((o) => (vOverlap(o) ? o.x - (r.x + r.width) : null));
  if (right)
    out.push({
      line: { x: r.x + r.width, y: midY(right[0]), width: right[1], height: 0 },
      value: right[1],
    });
  const above = near((o) => (hOverlap(o) ? r.y - (o.y + o.height) : null));
  if (above)
    out.push({
      line: { x: midX(above[0]), y: r.y - above[1], width: 0, height: above[1] },
      value: above[1],
    });
  const below = near((o) => (hOverlap(o) ? o.y - (r.y + r.height) : null));
  if (below)
    out.push({
      line: { x: midX(below[0]), y: r.y + r.height, width: 0, height: below[1] },
      value: below[1],
    });
  // Round first: a sub-pixel gap would otherwise show as a "0" guide.
  return out.map((d) => ({ ...d, value: Math.round(d.value) })).filter((d) => d.value > 0);
}
