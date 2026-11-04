'use client';

/**
 * Resize handles (Story 3.5). Dragging a handle previews the new size on the live DOM (inline
 * styles), snaps edges to siblings and the parent (hold Cmd/Ctrl to disable, Shift keeps the
 * aspect ratio), and commits fixed width/height (plus top/left for absolute nodes) as one op on
 * release. Double-click a handle to hug content on that axis.
 */
import {
  ALL_HANDLES,
  FLOW_HANDLES,
  resizeRect,
  snapResizeRect,
  worldRectToScreen,
  type Handle,
} from '@crunch/canvas';
import type { DocOp } from '@crunch/doc-model';
import { useDocStore, useDocStoreApi, useEditor } from '../doc-store';
import { gestureBreakpoint, useCanvas, useCanvasStoreApi } from './canvas-store';
import { frameIndex, useViewportRef } from './context';
import { nodeElement, worldRect } from './dom';
import { startGesture } from './gesture';
import { SNAP_PX, snapTargets } from './guides';
import { ACCENT, useWorldRects } from './selection-overlay';

const CURSOR: Record<Handle, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

const PREVIEW_PROPS = [
  'width',
  'height',
  'left',
  'top',
  'flex-grow',
  'flex-basis',
  'max-width',
  'max-height',
];

export function ResizeHandles() {
  const { designSystem } = useEditor();
  const doc = useDocStore((s) => s.doc);
  const ids = useDocStore((s) => s.selection.nodeIds);
  const readOnly = useDocStore((s) => s.readOnly);
  const camera = useCanvas((s) => s.camera);
  const gesture = useCanvas((s) => s.gesture);
  const viewport = useViewportRef();
  const docStore = useDocStoreApi();
  const canvas = useCanvasStoreApi();
  const id = ids.length === 1 ? ids[0]! : null;
  const frameId = id ? frameIndex(doc).get(id) : undefined;
  const rects = useWorldRects(id && frameId ? [{ frameId, nodeId: id }] : []);
  const node = id ? doc.nodes[id] : undefined;
  const world = id && frameId ? rects.get(`${frameId}:${id}`) : undefined;
  if (readOnly || !node || !frameId || !world || (gesture && gesture !== 'resize')) return null;

  const r = worldRectToScreen(camera, world);
  const handles = node.positioning === 'absolute' ? ALL_HANDLES : FLOW_HANDLES;
  const frame = doc.frames.find((f) => f.id === frameId);

  const onDown = (h: Handle) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const vp = viewport.current!;
    const el = nodeElement(vp, frameId, node.id);
    if (!el) return;
    const cam = canvas.getState().camera;
    const start = worldRect(vp, el, cam);
    const offset = { left: el.offsetLeft, top: el.offsetTop };
    const { maxWidth: maxW, maxHeight: maxH } = getComputedStyle(el);
    const others = snapTargets(vp, cam, docStore.getState().doc, frameId, [node.id]);
    const absolute = node.positioning === 'absolute';
    let next = start;
    const clear = () => {
      for (const p of PREVIEW_PROPS) el.style.removeProperty(p);
      canvas.getState().setGuides(null);
      canvas.getState().setGesture(null);
      canvas.getState().bumpLayout();
    };
    startGesture(e, {
      onStart: () => canvas.getState().setGesture('resize'),
      onMove: (ev, dx, dy) => {
        const z = canvas.getState().camera.z;
        let rr = resizeRect(start, h, dx / z, dy / z, ev.shiftKey);
        let lines: typeof others = [];
        if (!(ev.metaKey || ev.ctrlKey)) {
          const s = snapResizeRect(rr, h, others, SNAP_PX / z);
          rr = s.rect;
          lines = s.lines;
        }
        next = { x: rr.x, y: rr.y, width: Math.round(rr.width), height: Math.round(rr.height) };
        const set = (p: string, v: string) => el.style.setProperty(p, v, 'important');
        if (h.includes('e') || h.includes('w')) {
          set('width', `${next.width}px`);
          set('max-width', 'none');
        }
        if (h.includes('n') || h.includes('s')) {
          set('height', `${next.height}px`);
          set('max-height', 'none');
        }
        set('flex-grow', '0');
        set('flex-basis', 'auto');
        if (absolute) {
          if (h.includes('w')) set('left', `${Math.round(offset.left + next.x - start.x)}px`);
          if (h.includes('n')) set('top', `${Math.round(offset.top + next.y - start.y)}px`);
        }
        canvas.getState().setGuides({
          lines,
          label: {
            x: next.x + next.width / 2,
            y: next.y + next.height,
            text: `${next.width} × ${next.height}`,
          },
        });
        canvas.getState().bumpLayout();
      },
      onEnd: (_ev, moved) => {
        clear();
        if (!moved) return;
        const st = docStore.getState();
        const bp = gestureBreakpoint(frame, designSystem.spec);
        const ops: DocOp[] = [];
        const set = (prop: string, value: number) =>
          ops.push({ op: 'setStyle', id: node.id, breakpoint: bp, prop, value });
        // A max-width/height smaller than the new size would clamp it: lift it at this breakpoint.
        const clamps = (max: string, v: number) => max !== 'none' && parseFloat(max) < v;
        if (h.includes('e') || h.includes('w')) {
          set('width', next.width);
          if (clamps(maxW, next.width))
            ops.push({
              op: 'setStyle',
              id: node.id,
              breakpoint: bp,
              prop: 'maxWidth',
              value: 'none',
            });
        }
        if (h.includes('n') || h.includes('s')) {
          set('height', next.height);
          if (clamps(maxH, next.height))
            ops.push({
              op: 'setStyle',
              id: node.id,
              breakpoint: bp,
              prop: 'maxHeight',
              value: 'none',
            });
        }
        if (absolute && h.includes('w')) set('left', Math.round(offset.left + next.x - start.x));
        if (absolute && h.includes('n')) set('top', Math.round(offset.top + next.y - start.y));
        st.apply(ops, { source: 'canvas', label: 'Resize layer' });
      },
      onCancel: clear,
    });
  };

  const hug = (h: Handle) => () => {
    const bp = gestureBreakpoint(frame, designSystem.spec);
    const ops: DocOp[] = [];
    if (h.includes('e') || h.includes('w'))
      ops.push({ op: 'setStyle', id: node.id, breakpoint: bp, prop: 'width', value: 'hug' });
    if (h.includes('n') || h.includes('s'))
      ops.push({ op: 'setStyle', id: node.id, breakpoint: bp, prop: 'height', value: 'hug' });
    docStore.getState().apply(ops, { source: 'canvas', label: 'Hug contents' });
  };

  const pos = (h: Handle) => ({
    left: h.includes('w') ? r.x : h.includes('e') ? r.x + r.width : r.x + r.width / 2,
    top: h.includes('n') ? r.y : h.includes('s') ? r.y + r.height : r.y + r.height / 2,
  });

  return (
    <div data-cd-resize="">
      {handles.map((h) => (
        <div
          key={h}
          data-handle={h}
          role="slider"
          aria-label={`Resize ${h}`}
          aria-valuenow={Math.round(h === 'n' || h === 's' ? world.height : world.width)}
          onPointerDown={onDown(h)}
          onDoubleClick={hug(h)}
          style={{
            position: 'absolute',
            ...pos(h),
            width: 9,
            height: 9,
            marginLeft: -4.5,
            marginTop: -4.5,
            background: '#fff',
            border: `1.5px solid ${ACCENT}`,
            borderRadius: 2,
            cursor: CURSOR[h],
            pointerEvents: 'auto',
          }}
        />
      ))}
    </div>
  );
}

/** Smart guide lines and the live size label. */
export function GuidesOverlay() {
  const guides = useCanvas((s) => s.guides);
  const camera = useCanvas((s) => s.camera);
  if (!guides) return null;
  return (
    <div data-cd-guides="">
      {guides.lines.map((l, i) => {
        const r = worldRectToScreen(camera, l);
        return (
          <div
            key={i}
            data-guide=""
            style={{
              position: 'absolute',
              left: r.x,
              top: r.y,
              width: Math.max(1, r.width),
              height: Math.max(1, r.height),
              background: '#f43f5e',
            }}
          />
        );
      })}
      {guides.label && (
        <div
          style={{
            position: 'absolute',
            left: guides.label.x * camera.z + camera.x,
            top: guides.label.y * camera.z + camera.y + 6,
            transform: 'translateX(-50%)',
            fontSize: 11,
            padding: '0 4px',
            borderRadius: 3,
            background: ACCENT,
            color: '#fff',
            whiteSpace: 'nowrap',
          }}
        >
          {guides.label.text}
        </div>
      )}
    </div>
  );
}
