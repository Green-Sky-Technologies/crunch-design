'use client';

/**
 * Insert tools on the canvas (edit panel tool row). With a tool active, press inside a frame and
 * click (default size) or drag (drawn size) to insert into the container under the pointer, at the
 * flow position nearest the press. Holding Alt places it freely (absolute) where it was drawn;
 * arrows and pencil strokes are always placed where they were drawn. The new node is selected and
 * the tool reverts to Select. One undo step per insert.
 */
import {
  dropIndex,
  insertNodeOps,
  isContainer,
  isLocked,
  selectableAt,
  simplifyStroke,
  VECTOR_TOOLS,
  type ChildBox,
  type InsertSpec,
  type InsertTool,
  type Point,
  type Rect,
} from '@crunch/canvas';
import type { DesignDoc } from '@crunch/doc-model';
import { frameIndex } from './context';
import { flowOf, nodeElement, type Hit } from './dom';
import type { DragCtx } from './drag';
import { startGesture } from './gesture';
import { startTextEdit } from './text-edit';

export const TOOL_LABELS: Record<InsertTool, string> = {
  text: 'text',
  box: 'frame',
  rect: 'rectangle',
  ellipse: 'ellipse',
  line: 'line',
  arrow: 'arrow',
  pencil: 'drawing',
  image: 'image',
  component: 'component',
};

/** The container a press inserts into, and the index nearest the pointer along its flow. */
export function insertTarget(
  ctx: Pick<DragCtx, 'viewport'>,
  doc: DesignDoc,
  hit: Hit,
  p: Point,
): { parentId: string; index: number } | null {
  const id = selectableAt(doc, hit.nodeId);
  if (!id) return null;
  const n = doc.nodes[id]!;
  const parentId = isContainer(n) ? id : n.parentId;
  if (!parentId || isLocked(doc, parentId)) return null;
  const parent = doc.nodes[parentId]!;
  const pel = nodeElement(ctx.viewport, hit.frameId, parentId);
  const children: ChildBox[] = [];
  for (const c of parent.children) {
    const cn = doc.nodes[c];
    if (!cn || cn.hidden || cn.positioning === 'absolute') continue;
    const el = nodeElement(ctx.viewport, hit.frameId, c);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    children.push({ id: c, rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
  }
  const flow = pel ? flowOf(pel) : { direction: 'column' as const };
  const before = children[dropIndex(children, p, flow)]?.id;
  const index = before ? parent.children.indexOf(before) : parent.children.length;
  return { parentId, index };
}

/** Start an insert from a press on a frame. Returns true if the press was consumed. */
export function startInsert(ctx: DragCtx, down: PointerEvent, hit: Hit): boolean {
  const { docStore, canvas } = ctx;
  const { tool, toolArg } = canvas.getState();
  if (tool === 'select') return false;
  const s = docStore.getState();
  if (s.readOnly) return true;
  const target = insertTarget(ctx, s.doc, hit, { x: down.clientX, y: down.clientY });
  if (!target) {
    canvas.getState().setMessage('Can’t insert here: the layer is locked.');
    return true;
  }
  const parentEl = nodeElement(ctx.viewport, hit.frameId, target.parentId);
  const start = { x: down.clientX, y: down.clientY };
  const points: Point[] = [start];
  let end = start;

  const z = () => canvas.getState().camera.z;
  const v = () => ctx.viewport.getBoundingClientRect();
  /** Client-space rect between two points. */
  const between = (a: Point, b: Point): Rect => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  });
  const toWorld = (r: Rect): Rect => {
    const c = canvas.getState().camera;
    const vr = v();
    return {
      x: (r.x - vr.left - c.x) / c.z,
      y: (r.y - vr.top - c.y) / c.z,
      width: r.width / c.z,
      height: r.height / c.z,
    };
  };
  const done = () => {
    canvas.getState().setInsertBox(null);
    canvas.getState().setGesture(null);
  };

  startGesture(down, {
    onStart: () => canvas.getState().setGesture('drag'),
    onMove: (e) => {
      end = { x: e.clientX, y: e.clientY };
      if (tool === 'pencil') points.push(end);
      canvas.getState().setInsertBox(toWorld(between(start, end)));
    },
    onEnd: (e, moved) => {
      done();
      const zoom = z();
      const drawn = between(start, end);
      const dragged = moved && (drawn.width > 3 || drawn.height > 3);
      const vector = VECTOR_TOOLS.has(tool);
      if (tool === 'pencil' && !dragged) return;
      const spec: InsertSpec = { tool, ...toolArg };

      // Box drawn, in CSS px (frames render 1:1 in world space).
      let box = { x: drawn.x, y: drawn.y, width: drawn.width / zoom, height: drawn.height / zoom };
      if (vector) {
        const pad = 6;
        const pts =
          tool === 'arrow'
            ? [start, dragged ? end : { x: start.x + 160 * zoom, y: start.y }]
            : points;
        const bx = Math.min(...pts.map((p) => p.x));
        const by = Math.min(...pts.map((p) => p.y));
        const bw = (Math.max(...pts.map((p) => p.x)) - bx) / zoom;
        const bh = (Math.max(...pts.map((p) => p.y)) - by) / zoom;
        spec.points = simplifyStroke(
          pts.map((p) => ({ x: (p.x - bx) / zoom + pad, y: (p.y - by) / zoom + pad })),
        );
        box = { x: bx - pad * zoom, y: by - pad * zoom, width: bw + pad * 2, height: bh + pad * 2 };
        spec.size = { width: box.width, height: box.height };
      } else if (dragged) {
        spec.size =
          tool === 'line'
            ? { width: Math.max(box.width, box.height), height: 1 }
            : { width: box.width, height: box.height };
      }
      if ((vector || e.altKey || down.altKey) && parentEl) {
        const pr = parentEl.getBoundingClientRect();
        spec.at = {
          left: (box.x - pr.left) / zoom - parentEl.clientLeft,
          top: (box.y - pr.top) / zoom - parentEl.clientTop,
        };
      }
      const st = docStore.getState();
      const built = insertNodeOps(spec, target.parentId, target.index, ctx.ds);
      if (!built) return;
      if (!st.apply(built.ops, { source: 'canvas', label: `Insert ${TOOL_LABELS[tool]}` })) return;
      const frameId = frameIndex(docStore.getState().doc).get(built.id) ?? hit.frameId;
      st.select({ frameId, nodeIds: [built.id] });
      canvas.getState().setTool('select');
      if (tool === 'text') {
        // Type straight away once the new node has rendered.
        requestAnimationFrame(() =>
          startTextEdit(
            { docStore, canvas, viewport: ctx.viewport },
            { frameId, nodeId: built.id },
          ),
        );
      }
    },
    onCancel: done,
  });
  return true;
}
