/** Frame-level helpers (Story 3.1): op builders for add/duplicate/delete and layout queries. */
import {
  newId,
  type Breakpoint,
  type DesignDoc,
  type DesignSystemSpec,
  type DocOp,
  type Frame,
  type Node,
} from '@crunch/doc-model';
import type { Rect } from './geometry';

export const FRAME_GAP = 160;
export const FRAME_PRESETS = [
  { label: 'Desktop', width: 1280, height: 800 },
  { label: 'Tablet', width: 768, height: 1024 },
  { label: 'Mobile', width: 390, height: 844 },
] as const;

/** Breakpoint a frame renders at, from its width (mobile-first, like the renderer's container queries). */
export function frameBreakpoint(frame: Pick<Frame, 'width'>, ds: DesignSystemSpec): Breakpoint {
  if (frame.width >= ds.breakpoints.lg) return 'lg';
  if (frame.width >= ds.breakpoints.md) return 'md';
  return 'base';
}

export type FrameSizes = Readonly<Record<string, { width: number; height: number }>>;

/** World-space rect of a frame. Auto-height frames use the measured height when known. */
export function frameRect(frame: Frame, sizes?: FrameSizes): Rect {
  const m = sizes?.[frame.id];
  const measured = m && m.height > 0 ? m : undefined; // 0 = not laid out yet
  const height =
    frame.height === 'auto'
      ? (measured?.height ?? 800)
      : Math.max(frame.height, measured?.height ?? 0);
  return { x: frame.canvas.x, y: frame.canvas.y, width: frame.width, height };
}

/** Where a new frame goes: to the right of everything on the canvas, top-aligned with the first frame. */
export function nextFramePosition(doc: DesignDoc): { x: number; y: number } {
  if (!doc.frames.length) return { x: 0, y: 0 };
  const right = Math.max(...doc.frames.map((f) => f.canvas.x + f.width));
  const top = Math.min(...doc.frames.map((f) => f.canvas.y));
  return { x: right + FRAME_GAP, y: top };
}

function uniqueName(doc: DesignDoc, base: string): string {
  const names = new Set(doc.frames.map((f) => f.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** An empty frame with a flex-column page root, like a new project's first frame. */
export function addFrameOps(
  doc: DesignDoc,
  opts: {
    name?: string;
    width?: number;
    height?: number | 'auto';
    at?: { x: number; y: number };
  } = {},
): { ops: DocOp[]; frameId: string } {
  const rootId = newId('n');
  const frameId = newId('f');
  const root: Node = {
    id: rootId,
    type: 'box',
    tag: 'main',
    name: 'Page',
    parentId: null,
    children: [],
    positioning: 'flow',
    props: {},
    style: {
      base: {
        display: 'flex',
        flexDirection: 'column',
        width: 'fill',
        minHeight: '100%',
        backgroundColor: { token: 'color.background' },
        fontFamily: { token: 'font.sans' },
      },
    },
  };
  const frame: Frame = {
    id: frameId,
    name: uniqueName(doc, opts.name ?? 'Frame'),
    rootNodeId: rootId,
    canvas: opts.at ?? nextFramePosition(doc),
    width: opts.width ?? 1280,
    height: opts.height ?? 800,
    previewBreakpoints: [],
  };
  return {
    ops: [{ op: 'insertFrame', index: doc.frames.length, frame, nodes: [root] }],
    frameId,
  };
}

/** Pre-order copy of a subtree with fresh ids. The copy's root gets `parentId`. */
export function cloneSubtree(
  doc: DesignDoc,
  rootId: string,
  parentId: string | null,
): { nodes: Node[]; idMap: Map<string, string> } {
  const idMap = new Map<string, string>();
  const order: Node[] = [];
  const stack = [rootId];
  while (stack.length) {
    const n = doc.nodes[stack.pop()!];
    if (!n) continue;
    order.push(n);
    idMap.set(n.id, newId('n'));
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
  const nodes = order.map((n) => {
    const copy = structuredClone(n) as Node;
    copy.id = idMap.get(n.id)!;
    copy.parentId = n.id === rootId ? parentId : idMap.get(n.parentId!)!;
    copy.children = n.children.map((c) => idMap.get(c)!);
    return copy;
  });
  return { nodes, idMap };
}

export function duplicateFrameOps(
  doc: DesignDoc,
  frameId: string,
): { ops: DocOp[]; frameId: string } | null {
  const index = doc.frames.findIndex((f) => f.id === frameId);
  const src = doc.frames[index];
  if (!src) return null;
  const { nodes } = cloneSubtree(doc, src.rootNodeId, null);
  const id = newId('f');
  const frame: Frame = {
    ...structuredClone(src),
    id,
    name: uniqueName(doc, `${src.name} copy`),
    rootNodeId: nodes[0]!.id,
    canvas: nextFramePosition(doc),
  };
  return { ops: [{ op: 'insertFrame', index: index + 1, frame, nodes }], frameId: id };
}

/** Map every node id to the frame that contains it. */
export function nodeFrameIndex(doc: DesignDoc): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of doc.frames) {
    const stack = [f.rootNodeId];
    while (stack.length) {
      const id = stack.pop()!;
      const n = doc.nodes[id];
      if (!n) continue;
      out.set(id, f.id);
      stack.push(...n.children);
    }
  }
  return out;
}

/** The frame containing a node, by walking up to its root. */
export function frameOfNode(doc: DesignDoc, nodeId: string): Frame | undefined {
  let n = doc.nodes[nodeId];
  for (let guard = 0; n && n.parentId !== null && guard < 10_000; guard++)
    n = doc.nodes[n.parentId];
  return n ? doc.frames.find((f) => f.rootNodeId === n!.id) : undefined;
}
