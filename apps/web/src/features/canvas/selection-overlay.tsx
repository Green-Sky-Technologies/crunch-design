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

export const ACCENT = 'var(--accent, #ff5a1f)';

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

export function SelectionOverlay() {
  const doc = useDocStore((s) => s.doc);
  const selection = useDocStore((s) => s.selection);
  const hover = useCanvas((s) => s.hover);
  const gesture = useCanvas((s) => s.gesture);
  const camera = useCanvas((s) => s.camera);
  const index = frameIndex(doc);

  const selected: Target[] = selection.nodeIds.flatMap((id) => {
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
      {singleRect && singleNode && (
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
