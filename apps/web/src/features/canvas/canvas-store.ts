'use client';

/**
 * Canvas UI state that isn't part of the document: camera, viewport size, measured frame sizes,
 * hover, and the active gesture. One store per doc store, shared by the canvas and inspector panes
 * (they're siblings in the editor shell, so it's keyed off the doc store rather than a provider).
 *
 * The camera changes on every pan/zoom frame. The world layer applies it by subscribing and
 * writing `transform` directly, so frames never re-render for camera moves (ADR 0001).
 */
import { type Camera } from '@crunch/canvas';
import type { Breakpoint } from '@crunch/doc-model';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useDocStoreApi, type DocStore } from '../doc-store';

export interface Size {
  width: number;
  height: number;
}

export interface CanvasState {
  camera: Camera;
  viewport: Size;
  /** Measured frame sizes in world px (auto-height frames grow with content). */
  sizes: Record<string, Size>;
  /** Node under the pointer (hover outline). */
  hover: { frameId: string; nodeId: string } | null;
  /** Active pointer gesture, so overlays and shortcuts can adapt. */
  gesture: null | 'pan' | 'frame-move' | 'frame-resize' | 'drag' | 'resize' | 'text';
  /** Bumped when frame layout changes without a camera move (overlays re-measure). */
  layoutTick: number;
  /** True once the camera has been fitted to the content for the first time. */
  fitted: boolean;
  layersOpen: boolean;
  /** Live preview of a frame move/resize gesture (committed as one op on release). */
  framePreview: { frameId: string; dx: number; dy: number; width?: number } | null;
  setFramePreview(p: CanvasState['framePreview']): void;
  /** Breakpoint the inspector edits; null follows the selected frame's breakpoint. */
  editBreakpoint: Breakpoint | null;
  setEditBreakpoint(bp: Breakpoint | null): void;
  setCamera(c: Camera): void;
  setViewport(s: Size): void;
  setSize(frameId: string, s: Size): void;
  setHover(h: CanvasState['hover']): void;
  setGesture(g: CanvasState['gesture']): void;
  bumpLayout(): void;
  setFitted(): void;
  toggleLayers(open?: boolean): void;
}

export type CanvasStore = StoreApi<CanvasState>;

export function createCanvasStore(): CanvasStore {
  return createStore<CanvasState>()((set) => ({
    camera: { x: 48, y: 48, z: 0.5 },
    viewport: { width: 0, height: 0 },
    sizes: {},
    hover: null,
    gesture: null,
    layoutTick: 0,
    fitted: false,
    layersOpen: true,
    framePreview: null,
    editBreakpoint: null,
    setEditBreakpoint: (editBreakpoint) => set({ editBreakpoint }),
    setFramePreview: (framePreview) => set({ framePreview }),
    setCamera: (camera) => set({ camera }),
    setViewport: (viewport) => set({ viewport }),
    setSize: (frameId, s) =>
      set((st) => {
        const prev = st.sizes[frameId];
        if (prev && prev.width === s.width && prev.height === s.height) return st;
        return { sizes: { ...st.sizes, [frameId]: s }, layoutTick: st.layoutTick + 1 };
      }),
    setHover: (hover) =>
      set((st) =>
        st.hover?.nodeId === hover?.nodeId && st.hover?.frameId === hover?.frameId ? st : { hover },
      ),
    setGesture: (gesture) => set({ gesture }),
    bumpLayout: () => set((st) => ({ layoutTick: st.layoutTick + 1 })),
    setFitted: () => set({ fitted: true }),
    toggleLayers: (open) => set((st) => ({ layersOpen: open ?? !st.layersOpen })),
  }));
}

const stores = new WeakMap<DocStore, CanvasStore>();

export function canvasStoreFor(doc: DocStore): CanvasStore {
  let s = stores.get(doc);
  if (!s) {
    s = createCanvasStore();
    stores.set(doc, s);
  }
  return s;
}

export function useCanvasStoreApi(): CanvasStore {
  return canvasStoreFor(useDocStoreApi());
}

export function useCanvas<T>(selector: (s: CanvasState) => T): T {
  return useStore(useCanvasStoreApi(), selector);
}
