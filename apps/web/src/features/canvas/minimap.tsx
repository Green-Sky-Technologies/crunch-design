'use client';

/** Minimap (Story 3.1): every frame plus the visible area; click or drag to move the camera. */
import {
  centerOn,
  frameRect,
  minimapLayout,
  minimapToWorld,
  viewportWorldRect,
} from '@crunch/canvas';
import { useDocStore } from '../doc-store';
import { useCanvas, useCanvasStoreApi } from './canvas-store';
import { startGesture } from './gesture';

const W = 180;
const H = 120;

export function Minimap() {
  const frames = useDocStore((s) => s.doc.frames);
  const selectedFrame = useDocStore((s) => s.selection.frameId);
  const camera = useCanvas((s) => s.camera);
  const viewport = useCanvas((s) => s.viewport);
  const sizes = useCanvas((s) => s.sizes);
  const canvas = useCanvasStoreApi();
  if (!frames.length || !viewport.width) return null;

  const m = minimapLayout(
    frames.map((f) => frameRect(f, sizes)),
    viewportWorldRect(camera, viewport),
    { width: W, height: H },
  );

  const moveTo = (e: { clientX: number; clientY: number }, svg: SVGSVGElement) => {
    const r = svg.getBoundingClientRect();
    const p = minimapToWorld(m, { x: e.clientX - r.left, y: e.clientY - r.top });
    const st = canvas.getState();
    st.setCamera(centerOn(st.camera, p, st.viewport));
  };

  return (
    <svg
      aria-label="Minimap"
      role="img"
      width={W}
      height={H}
      className="card shadow-sm"
      style={{
        position: 'absolute',
        right: 12,
        bottom: 12,
        cursor: 'pointer',
        touchAction: 'none',
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        const svg = e.currentTarget;
        moveTo(e, svg);
        startGesture(e, { onMove: (ev) => moveTo(ev, svg) }, 0);
      }}
    >
      {m.frames.map((r, i) => (
        <rect
          key={frames[i]!.id}
          x={r.x}
          y={r.y}
          width={Math.max(1, r.width)}
          height={Math.max(1, r.height)}
          fill={
            frames[i]!.id === selectedFrame ? 'var(--accent, #ff5a1f)' : 'var(--muted, #9c9a93)'
          }
          opacity={0.45}
        />
      ))}
      <rect
        data-cd-minimap-viewport=""
        x={m.viewport.x}
        y={m.viewport.y}
        width={m.viewport.width}
        height={m.viewport.height}
        fill="none"
        stroke="var(--accent, #ff5a1f)"
        strokeWidth={1.5}
      />
    </svg>
  );
}
