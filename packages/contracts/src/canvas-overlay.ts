'use client';

/**
 * Canvas overlay registry (Stories 3.2, 6.1).
 * Lets features render UI anchored to nodes on the canvas (comment pins, lint badges, agent
 * activity markers) without editing canvas code.
 *
 * Registration is implemented here (it's generic). The canvas stream provides the
 * OverlayApi (node rects in overlay coordinates, zoom) and renders registered overlays
 * inside its overlay layer.
 */
import { useSyncExternalStore, type ComponentType } from 'react';

export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayApi {
  /** Bounding box of a node in overlay-layer coordinates, or null if not rendered. */
  getNodeRect(nodeId: string, frameId?: string): OverlayRect | null;
  /** Convert a canvas position (comment anchored to canvas) to overlay coordinates. */
  canvasToOverlay(point: { x: number; y: number }): { x: number; y: number };
  zoom: number;
  /** Re-render on pan/zoom/layout changes. Returns an unsubscribe function. */
  subscribe(cb: () => void): () => void;
  projectId: string;
  readOnly: boolean;
}

export interface CanvasOverlay {
  id: string;
  /** Higher renders on top. */
  order?: number;
  Component: ComponentType<{ api: OverlayApi }>;
}

let overlays: CanvasOverlay[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Register an overlay; returns an unregister function. Re-registering an id replaces it. */
export function registerOverlay(o: CanvasOverlay): () => void {
  overlays = [...overlays.filter((x) => x.id !== o.id), o].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0),
  );
  emit();
  return () => {
    overlays = overlays.filter((x) => x !== o);
    emit();
  };
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const snapshot = () => overlays;

/** For the canvas: the current overlays, re-rendering on change. */
export function useCanvasOverlays(): CanvasOverlay[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
