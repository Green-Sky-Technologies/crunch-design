'use client';

/** Snap targets for smart guides: a node's visible siblings and its parent, in world coordinates. */
import type { Camera, Rect } from '@crunch/canvas';
import type { DesignDoc } from '@crunch/doc-model';
import { nodeElement, worldRect } from './dom';

export const SNAP_PX = 6; // screen px

export function snapTargets(
  viewport: HTMLElement,
  camera: Camera,
  doc: DesignDoc,
  frameId: string,
  ids: readonly string[],
): Rect[] {
  const parents = new Set(ids.map((id) => doc.nodes[id]?.parentId).filter((p): p is string => !!p));
  const out: Rect[] = [];
  for (const p of parents) {
    const pel = nodeElement(viewport, frameId, p);
    if (pel) out.push(worldRect(viewport, pel, camera));
    for (const c of doc.nodes[p]!.children) {
      if (ids.includes(c) || doc.nodes[c]?.hidden) continue;
      const el = nodeElement(viewport, frameId, c);
      if (el) out.push(worldRect(viewport, el, camera));
    }
  }
  return out;
}
