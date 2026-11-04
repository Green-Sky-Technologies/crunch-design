'use client';

/**
 * Node dragging (Story 3.4). Flow-first: dragging shows a drop indicator and, on release, moves
 * the selection with moveNode (reorder or reparent), one undo step. Holding Alt at the start, or
 * dragging nodes that are already absolute, places them freely with top/left relative to the
 * nearest positioned ancestor (every box renders position:relative, so that's the parent).
 * During the gesture nothing touches the doc; previews are inline styles on the live DOM.
 */
import {
  absolutePlacementOps,
  canDropInto,
  dropIndex,
  dropLine,
  isContainer,
  isLocked,
  moveOps,
  selectableAt,
  snapMoveRect,
  spacingGuides,
  subtreeSet,
  toFlowOps,
  topLevelSelection,
  union,
  widthToPin,
  type ChildBox,
  type Rect,
} from '@crunch/canvas';
import type { Breakpoint, DesignDoc, DesignSystemSpec, DocOp } from '@crunch/doc-model';
import type { DocStore } from '../doc-store';
import { gestureBreakpoint, type CanvasStore } from './canvas-store';
import { frameIndex } from './context';
import { flowOf, hitFromPoint, nodeElement, worldRect, type Hit } from './dom';
import { startGesture } from './gesture';
import { SNAP_PX, snapTargets } from './guides';

export interface DragCtx {
  docStore: DocStore;
  canvas: CanvasStore;
  viewport: HTMLElement;
  ds: DesignSystemSpec;
}

const EDGE = 8; // screen px near a container's edge that means "beside it", not "into it"

const toWorld = (
  ctx: DragCtx,
  r: { left: number; top: number; width: number; height: number },
): Rect => {
  const v = ctx.viewport.getBoundingClientRect();
  const c = ctx.canvas.getState().camera;
  return {
    x: (r.left - v.left - c.x) / c.z,
    y: (r.top - v.top - c.y) / c.z,
    width: r.width / c.z,
    height: r.height / c.z,
  };
};

interface FlowTarget {
  parentId: string;
  beforeId: string | null;
  frameId: string;
}

/** Where a flow drop at a client point would go, plus its indicator. */
export function flowTargetAt(
  ctx: DragCtx,
  doc: DesignDoc,
  dragged: Set<string>,
  dragIds: string[],
  draggedEls: HTMLElement[],
  x: number,
  y: number,
): { target: FlowTarget; line: Rect; container: Rect } | null {
  const hit = hitFromPoint(x, y, (el) => draggedEls.some((d) => d.contains(el)));
  if (!hit) return null;
  const hid = selectableAt(doc, hit.nodeId);
  if (!hid || dragged.has(hid)) return null;
  const hn = doc.nodes[hid]!;
  const hel = nodeElement(ctx.viewport, hit.frameId, hid);
  if (!hel) return null;

  let parentId = hid;
  if (!isContainer(hn) && hn.parentId) parentId = hn.parentId;
  else if (hn.parentId) {
    // Near the container's edge along its parent's flow: drop beside it instead of into it.
    const parentEl = nodeElement(ctx.viewport, hit.frameId, hn.parentId);
    const r = hel.getBoundingClientRect();
    const dir = parentEl ? flowOf(parentEl).direction : 'column';
    const near =
      dir === 'column'
        ? y - r.top < EDGE || r.bottom - y < EDGE
        : x - r.left < EDGE || r.right - x < EDGE;
    if (near) parentId = hn.parentId;
  }
  // Nothing can be dropped into a locked container (that would edit it).
  if (!canDropInto(doc, dragIds, parentId) || isLocked(doc, parentId)) return null;
  const cel = nodeElement(ctx.viewport, hit.frameId, parentId);
  if (!cel) return null;
  const flow = flowOf(cel);
  const children: ChildBox[] = [];
  for (const id of doc.nodes[parentId]!.children) {
    if (dragged.has(id) || doc.nodes[id]?.hidden || doc.nodes[id]?.positioning === 'absolute')
      continue;
    const el = nodeElement(ctx.viewport, hit.frameId, id);
    if (el) {
      const r = el.getBoundingClientRect();
      children.push({ id, rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
    }
  }
  const index = dropIndex(children, { x, y }, flow);
  const cr = cel.getBoundingClientRect();
  const line = dropLine(
    children,
    index,
    { x: cr.left, y: cr.top, width: cr.width, height: cr.height },
    flow,
  );
  return {
    target: { parentId, beforeId: children[index]?.id ?? null, frameId: hit.frameId },
    line: toWorld(ctx, { left: line.x, top: line.y, width: line.width, height: line.height }),
    container: toWorld(ctx, cr),
  };
}

/** Start a drag from a press on a selected node. Returns false if there's nothing to drag. */
export function startNodeDrag(ctx: DragCtx, down: PointerEvent, hit: Hit): boolean {
  const { docStore, canvas } = ctx;
  const s = docStore.getState();
  if (s.readOnly) return false;
  if (s.selection.nodeIds.some((id) => isLocked(s.doc, id))) {
    ctx.canvas.getState().setMessage('Locked layers can’t be moved. Unlock them in the inspector.');
    return false;
  }
  const doc0 = s.doc;
  const dragIds = topLevelSelection(doc0, s.selection.nodeIds);
  if (
    !dragIds.length ||
    !dragIds.some((id) => id === hit.nodeId || subtreeSet(doc0, [id]).has(hit.nodeId))
  )
    return false;
  const index = frameIndex(doc0);
  const els = dragIds.map((id) => nodeElement(ctx.viewport, index.get(id) ?? hit.frameId, id));
  if (els.some((e) => !e)) return false;
  const draggedEls = els as HTMLElement[];
  const dragged = subtreeSet(doc0, dragIds);
  const absolute = down.altKey || dragIds.every((id) => doc0.nodes[id]!.positioning === 'absolute');
  if (absolute && draggedEls.some(transformedAncestor)) {
    // Screen deltas no longer map 1:1 to the parent's CSS px under a scale/rotate.
    canvas
      .getState()
      .setMessage(
        'Free placement is off inside a scaled or rotated container. Use flow, or the inspector.',
      );
    return false;
  }
  let target: FlowTarget | null = null;
  let delta = { x: 0, y: 0 };
  let startBounds: Rect | null = null;
  let others: Rect[] = [];

  const restore = () => {
    for (const el of draggedEls) {
      el.style.removeProperty('opacity');
      el.style.removeProperty('translate');
    }
    canvas.getState().setDrop(null);
    canvas.getState().setGuides(null);
    canvas.getState().setGesture(null);
    canvas.getState().bumpLayout();
  };

  startGesture(
    down,
    {
      onStart: () => {
        canvas.getState().setGesture('drag');
        if (!absolute) for (const el of draggedEls) el.style.setProperty('opacity', '0.35');
        else {
          // Smart guides for free placement: the selection's bounds against siblings and parent.
          const cam = canvas.getState().camera;
          startBounds = union(draggedEls.map((el) => worldRect(ctx.viewport, el, cam)));
          others = snapTargets(ctx.viewport, cam, doc0, hit.frameId, dragIds);
        }
      },
      onMove: (e, dx, dy) => {
        if (absolute) {
          const z = canvas.getState().camera.z;
          delta = { x: dx / z, y: dy / z };
          if (startBounds && !(e.metaKey || e.ctrlKey)) {
            const moved = {
              ...startBounds,
              x: startBounds.x + delta.x,
              y: startBounds.y + delta.y,
            };
            const s = snapMoveRect(moved, others, SNAP_PX / z);
            delta = { x: s.rect.x - startBounds.x, y: s.rect.y - startBounds.y };
            const distances = spacingGuides(s.rect, others);
            canvas
              .getState()
              .setGuides(s.lines.length || distances.length ? { lines: s.lines, distances } : null);
          }
          delta = { x: Math.round(delta.x), y: Math.round(delta.y) };
          for (const el of draggedEls)
            el.style.setProperty('translate', `${delta.x}px ${delta.y}px`);
          canvas.getState().bumpLayout();
          return;
        }
        const t = flowTargetAt(
          ctx,
          docStore.getState().doc,
          dragged,
          dragIds,
          draggedEls,
          e.clientX,
          e.clientY,
        );
        target = t?.target ?? null;
        canvas.getState().setDrop(t ? { line: t.line, container: t.container } : null);
      },
      onEnd: (_e, moved) => {
        const offsets = draggedEls.map(placementBox);
        restore();
        if (!moved) return;
        const st = docStore.getState();
        if (absolute) {
          const frame = st.doc.frames.find((f) => f.id === hit.frameId);
          const bp = gestureBreakpoint(frame, ctx.ds);
          for (const id of dragIds) rememberPinnedWidth(st.doc, id);
          const ops = dragIds.flatMap((id, i) =>
            absolutePlacementOps(
              st.doc,
              id,
              bp,
              { left: offsets[i]!.left + delta.x, top: offsets[i]!.top + delta.y },
              { width: offsets[i]!.width },
            ),
          );
          if (ops.length)
            st.apply(ops, {
              source: 'canvas',
              label: dragIds.length > 1 ? 'Move layers' : 'Move layer',
            });
          return;
        }
        if (!target) return;
        const ops = moveOps(st.doc, dragIds, target.parentId, target.beforeId);
        if (
          ops.length &&
          st.apply(ops, {
            source: 'canvas',
            label: dragIds.length > 1 ? 'Move layers' : 'Move layer',
          })
        )
          st.select({ frameId: target.frameId, nodeIds: dragIds });
      },
      onCancel: restore,
    },
    4,
  );
  return true;
}

/** Switch nodes between flow and absolute, keeping them visually in place (inspector toggle). */
export function positioningOps(
  doc: DesignDoc,
  ids: readonly string[],
  to: 'flow' | 'absolute',
  bp: Breakpoint,
  scope: ParentNode,
): DocOp[] {
  const index = frameIndex(doc);
  return ids.flatMap((id) => {
    if (to === 'flow') {
      const restore = pinnedWidths.get(id);
      pinnedWidths.delete(id);
      return toFlowOps(doc, id, restore);
    }
    const el = nodeElement(scope, index.get(id) ?? '', id);
    rememberPinnedWidth(doc, id);
    const box = el ? placementBox(el) : { left: 0, top: 0, width: 0 };
    return absolutePlacementOps(doc, id, bp, box, el ? { width: box.width } : undefined);
  });
}

/**
 * Widths pinned when nodes were made absolute (canvas session memory), so returning to flow
 * restores what was there instead of leaving a fixed width behind.
 */
const pinnedWidths = new Map<string, { previous: unknown }>();
function rememberPinnedWidth(doc: DesignDoc, id: string) {
  if (doc.nodes[id]?.positioning === 'absolute') return;
  const pin = widthToPin(doc, id);
  if (pin) pinnedWidths.set(id, pin);
}

/**
 * Where CSS left/top must be to keep the element's box in place: offsetLeft/Top measure the
 * border box from the offset parent's padding edge, but left/top place the margin box.
 */
export function placementBox(el: HTMLElement): { left: number; top: number; width: number } {
  const cs = getComputedStyle(el);
  return {
    left: el.offsetLeft - (parseFloat(cs.marginLeft) || 0),
    top: el.offsetTop - (parseFloat(cs.marginTop) || 0),
    width: el.offsetWidth,
  };
}

/** True if an ancestor inside the frame is scaled, rotated or transformed. */
export function transformedAncestor(el: HTMLElement): boolean {
  for (let p = el.parentElement; p && !p.classList.contains('cd-frame'); p = p.parentElement) {
    const cs = getComputedStyle(p);
    const set = (v: string | undefined) => !!v && v !== 'none';
    if (set(cs.transform) || set(cs.scale) || set(cs.rotate)) return true;
  }
  return false;
}
