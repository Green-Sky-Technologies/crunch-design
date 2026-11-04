'use client';

import { fitCamera, frameRect, union } from '@crunch/canvas';
import type { DesignDoc } from '@crunch/doc-model';
import type { CanvasStore } from './canvas-store';

/** Width the layers panel covers on the left of the viewport, when open. */
export const LAYERS_INSET = 256;

/** Fit every frame in the viewport (never zooming in past 100%), clear of the layers panel. */
export function fitAll(canvas: CanvasStore, doc: DesignDoc) {
  const { sizes, viewport, layersOpen } = canvas.getState();
  const bounds = union(doc.frames.map((f) => frameRect(f, sizes)));
  if (!bounds || !viewport.width) return;
  const inset = layersOpen && viewport.width > LAYERS_INSET * 2.5 ? LAYERS_INSET : 0;
  const c = fitCamera(bounds, { width: viewport.width - inset, height: viewport.height }, 64, 1);
  canvas.getState().setCamera({ ...c, x: c.x + inset });
}
