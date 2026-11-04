/**
 * Canvas camera (ADR 0001): the world layer is drawn with `translate(x, y) scale(z)`, so
 *   screen = world * z + (x, y)        world = (screen - (x, y)) / z
 * "Screen" here means coordinates relative to the canvas viewport element, not the page.
 */
import type { Point, Rect } from './geometry';

export interface Camera {
  x: number;
  y: number;
  z: number;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 4;
export const ZOOM_STEPS = [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4] as const;

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export const screenToWorld = (c: Camera, p: Point): Point => ({
  x: (p.x - c.x) / c.z,
  y: (p.y - c.y) / c.z,
});

export const worldToScreen = (c: Camera, p: Point): Point => ({
  x: p.x * c.z + c.x,
  y: p.y * c.z + c.y,
});

export const worldRectToScreen = (c: Camera, r: Rect): Rect => ({
  x: r.x * c.z + c.x,
  y: r.y * c.z + c.y,
  width: r.width * c.z,
  height: r.height * c.z,
});

export const screenRectToWorld = (c: Camera, r: Rect): Rect => ({
  x: (r.x - c.x) / c.z,
  y: (r.y - c.y) / c.z,
  width: r.width / c.z,
  height: r.height / c.z,
});

/** Zoom to `z` keeping the world point under `screenPoint` fixed. */
export function zoomAt(c: Camera, screenPoint: Point, z: number): Camera {
  const nz = clampZoom(z);
  const w = screenToWorld(c, screenPoint);
  return { x: screenPoint.x - w.x * nz, y: screenPoint.y - w.y * nz, z: nz };
}

export const pan = (c: Camera, dx: number, dy: number): Camera => ({
  ...c,
  x: c.x + dx,
  y: c.y + dy,
});

/** Next zoom step up or down from the current zoom (toolbar +/-). */
export function stepZoom(z: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z + 1e-6) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((s) => s < z - 1e-6) ?? MIN_ZOOM;
}

/** Wheel event -> new camera. Ctrl/Meta (and trackpad pinch, which sets ctrlKey) zooms. */
export function wheelCamera(
  c: Camera,
  e: {
    deltaX: number;
    deltaY: number;
    deltaMode: number;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  },
  at: Point,
): Camera {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const dx = e.deltaX * unit;
  const dy = e.deltaY * unit;
  if (e.ctrlKey || e.metaKey) {
    const factor = Math.exp(-Math.max(-50, Math.min(50, dy)) * 0.01);
    return zoomAt(c, at, c.z * factor);
  }
  if (e.shiftKey && dx === 0) return pan(c, -dy, 0);
  return pan(c, -dx, -dy);
}

/** Camera that fits `bounds` in a viewport of `size`, with `padding` screen px around it. */
export function fitCamera(
  bounds: Rect,
  size: { width: number; height: number },
  padding = 48,
  maxZoom = 1,
): Camera {
  const w = Math.max(1, size.width - padding * 2);
  const h = Math.max(1, size.height - padding * 2);
  const z = clampZoom(
    Math.min(maxZoom, w / Math.max(1, bounds.width), h / Math.max(1, bounds.height)),
  );
  return {
    x: (size.width - bounds.width * z) / 2 - bounds.x * z,
    y: Math.max(padding, (size.height - bounds.height * z) / 2) - bounds.y * z,
    z,
  };
}

/** Center the world point `p` in the viewport, keeping zoom. */
export const centerOn = (c: Camera, p: Point, size: { width: number; height: number }): Camera => ({
  ...c,
  x: size.width / 2 - p.x * c.z,
  y: size.height / 2 - p.y * c.z,
});

/** Visible world rect for a viewport size. */
export const viewportWorldRect = (c: Camera, size: { width: number; height: number }): Rect =>
  screenRectToWorld(c, { x: 0, y: 0, width: size.width, height: size.height });

export const cameraTransform = (c: Camera) => `translate(${c.x}px, ${c.y}px) scale(${c.z})`;
