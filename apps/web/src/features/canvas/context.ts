'use client';

import { nodeFrameIndex } from '@crunch/canvas';
import type { DesignDoc } from '@crunch/doc-model';
import { createContext, useContext, type RefObject } from 'react';

/** The canvas viewport element (overlay coordinates are relative to it). */
export const ViewportCtx = createContext<RefObject<HTMLDivElement | null> | null>(null);

export function useViewportRef(): RefObject<HTMLDivElement | null> {
  const r = useContext(ViewportCtx);
  if (!r) throw new Error('Canvas component outside CanvasPane');
  return r;
}

/** node id -> frame id, memoized per doc object (docs are immutable). */
const indexCache = new WeakMap<DesignDoc, Map<string, string>>();
export function frameIndex(doc: DesignDoc): Map<string, string> {
  let m = indexCache.get(doc);
  if (!m) {
    m = nodeFrameIndex(doc);
    indexCache.set(doc, m);
  }
  return m;
}
