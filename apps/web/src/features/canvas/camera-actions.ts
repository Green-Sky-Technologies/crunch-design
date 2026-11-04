'use client';

import { fitCamera, frameRect, union } from '@crunch/canvas';
import type { DesignDoc } from '@crunch/doc-model';
import type { CanvasStore } from './canvas-store';

/** Fit every frame in the viewport (never zooming in past 100%). */
export function fitAll(canvas: CanvasStore, doc: DesignDoc) {
  const { sizes, viewport } = canvas.getState();
  const bounds = union(doc.frames.map((f) => frameRect(f, sizes)));
  if (!bounds || !viewport.width) return;
  canvas.getState().setCamera(fitCamera(bounds, viewport, 64, 1));
}
