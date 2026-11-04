'use client';

/**
 * Selection and hover outlines (Story 3.2). Node rects are measured from the live DOM in world
 * coordinates after layout settles, then projected with the camera on every render, so outlines
 * stay correct at any zoom and at every breakpoint without re-measuring during pan/zoom.
 */
import { nodeLabel, worldRectToScreen, type Rect } from '@crunch/canvas';
import { useLayoutEffect, useState, type ReactNode } from 'react';
import { useDocStore } from '../doc-store';
import { useCanvas, useCanvasStoreApi } from './canvas-store';
import { frameIndex, useViewportRef } from './context';
import { nodeElement, worldRect } from './dom';

export const ACCENT = 'var(--accent, #cb4b16)';

export interface Target {
  frameId: string;
  nodeId: string;
}

const keyOf = (t: Target) => `${t.frameId}:${t.nodeId}`;

/** World rects of nodes, re-measured (one frame later) whenever the doc or layout changes. */
export function useWorldRects(targets: readonly Target[]): Map<string, Rect> {
  const viewport = useViewportRef();
  const canvas = useCanvasStoreApi();
  const doc = useDocStore((s) => s.doc);
  const layoutTick = useCanvas((s) => s.layoutTick);
  const framePreview = useCanvas((s) => s.framePreview);
  const key = targets.map(keyOf).join(',');
  const [rects, setRects] = useState<Map<string, Rect>>(() => new Map());

  useLayoutEffect(() => {
    const measure = () => {
      const vp = viewport.current;
      const m = new Map<string, Rect>();
      if (vp) {
        const cam = canvas.getState().camera;
        for (const k of key ? key.split(',') : []) {
          const [frameId, nodeId] = k.split(':') as [string, string];
          const el = nodeElement(vp, frameId, nodeId);
          if (el) m.set(k, worldRect(vp, el, cam));
        }
      }
      setRects(m);
    };
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [key, doc, layoutTick, framePreview, viewport, canvas]);

  return rects;
}

function Box({
  r,
  style,
  children,
}: {
  r: Rect;
  style?: React.CSSProperties;
  children?: ReactNode;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        left: r.x,
        top: r.y,
        width: r.width,
        height: r.height,
        pointerEvents: 'none',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

const tag: React.CSSProperties = {
  position: 'absolute',
  whiteSpace: 'nowrap',
  fontSize: 11,
  lineHeight: '16px',
  padding: '0 4px',
  borderRadius: 3,
  background: ACCENT,
  color: '#fff',
};

/** Flow drop target: the container outline and the insertion line. */
export function DropIndicator() {
  const drop = useCanvas((s) => s.drop);
  const camera = useCanvas((s) => s.camera);
  const editing = useCanvas((s) => s.mode === 'edit');
  if (!drop || !editing) return null;
  return (
    <div data-cd-drop="">
      <Box
        r={worldRectToScreen(camera, drop.container)}
        style={{
          outline: `1px dashed ${ACCENT}`,
          background: 'color-mix(in srgb, var(--accent, #cb4b16) 5%, transparent)',
        }}
      />
      <Box
        r={worldRectToScreen(camera, drop.line)}
        style={{ background: ACCENT, minWidth: 2, minHeight: 2, borderRadius: 1 }}
      >
        <span data-testid="drop-line" hidden />
      </Box>
    </div>
  );
}

/** Live outline of an insert-tool drag. */
export function InsertBoxOverlay() {
  const box = useCanvas((s) => s.insertBox);
  const camera = useCanvas((s) => s.camera);
  if (!box) return null;
  return (
    <div data-cd-insert-box="">
      <Box
        r={worldRectToScreen(camera, box)}
        style={{
          outline: `1px solid ${ACCENT}`,
          background: 'color-mix(in srgb, var(--accent, #cb4b16) 8%, transparent)',
        }}
      />
    </div>
  );
}

const NO_IDS: string[] = [];

/** Selection and hover outlines. Edit mode only: in view and comment mode the canvas is a preview. */
export function SelectionOverlay() {
  const doc = useDocStore((s) => s.doc);
  const selection = useDocStore((s) => s.selection);
  const editing = useCanvas((s) => s.mode === 'edit');
  const hover = useCanvas((s) => (s.mode === 'edit' ? s.hover : null));
  const gesture = useCanvas((s) => s.gesture);
  const camera = useCanvas((s) => s.camera);
  const index = frameIndex(doc);

  const selected: Target[] = (editing ? selection.nodeIds : NO_IDS).flatMap((id) => {
    const frameId = index.get(id);
    return frameId ? [{ frameId, nodeId: id }] : [];
  });
  const hovered =
    hover && !selection.nodeIds.includes(hover.nodeId) && doc.nodes[hover.nodeId] ? hover : null;
  const rects = useWorldRects(hovered ? [...selected, hovered] : selected);

  const single = selected.length === 1 ? selected[0]! : null;
  const singleRect = single && rects.get(keyOf(single));
  const singleNode = single && doc.nodes[single.nodeId];

  return (
    <div data-cd-selection="">
      {hovered && rects.get(keyOf(hovered)) && gesture === null && (
        <Box
          r={worldRectToScreen(camera, rects.get(keyOf(hovered))!)}
          style={{ outline: `1px solid ${ACCENT}`, opacity: 0.8 }}
        />
      )}
      {selected.map((t) => {
        const r = rects.get(keyOf(t));
        if (!r) return null;
        return (
          <Box
            key={keyOf(t)}
            r={worldRectToScreen(camera, r)}
            style={{ outline: `2px solid ${ACCENT}` }}
          >
            <span data-cd-selected={t.nodeId} hidden />
          </Box>
        );
      })}
      {singleRect && singleNode && gesture !== 'resize' && (
        <Box r={worldRectToScreen(camera, singleRect)}>
          <span style={{ ...tag, left: -2, top: -19 }}>{nodeLabel(singleNode)}</span>
          <span
            data-testid="selection-size"
            style={{
              ...tag,
              left: '50%',
              top: '100%',
              marginTop: 4,
              transform: 'translateX(-50%)',
            }}
          >
            {Math.round(singleRect.width)} × {Math.round(singleRect.height)}
          </span>
        </Box>
      )}
    </div>
  );
}
