'use client';

/**
 * The infinite canvas (Story 3.1, ADR 0001): a viewport with a CSS-transformed world layer of
 * live frames, and a screen-space overlay layer above it for frame chrome and selection UI.
 */
import {
  cameraTransform,
  frameRect,
  intersects,
  viewportWorldRect,
  wheelCamera,
  type Camera,
} from '@crunch/canvas';
import type { DesignDoc, DesignSystemSpec, Frame } from '@crunch/doc-model';
import { FrameView } from '@crunch/renderer/react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useDocStore, useDocStoreApi, useEditor } from '../doc-store';
import { fitAll } from './camera-actions';
import { useCanvas, useCanvasStoreApi } from './canvas-store';
import { ViewportCtx } from './context';
import { FrameChrome } from './frame-chrome';
import { LayersPanel } from './layers-panel';
import { useEditLockLoop } from './lock';
import { RegisteredOverlays } from './overlay-api';
import { GuidesOverlay, ResizeHandles } from './resize-handles';
import { useSelectionInput } from './selection-input';
import { DropIndicator, SelectionOverlay } from './selection-overlay';
import { isTypingEvent, startGesture } from './gesture';
import { Minimap } from './minimap';
import { CanvasMessage } from './canvas-message';
import { CanvasToolbar } from './toolbar';

/**
 * Performance marks (Story 3.10): `cd:first-frame` when the first frame's content is laid out,
 * `cd:canvas-interactive` when canvas input handlers are attached. Cheap, and visible in DevTools.
 */
let firstFrameMarked = false;
function markFirstFrame(wrap: HTMLElement) {
  if (firstFrameMarked || typeof performance === 'undefined') return;
  const root = wrap.querySelector('[data-cd-frame-host]')?.shadowRoot;
  if (root?.querySelector('[data-cd-id]') && wrap.offsetHeight > 0) {
    firstFrameMarked = true;
    performance.mark('cd:first-frame');
  }
}

/**
 * Progressive mounting (Story 3.10): on load, the first frame renders immediately and the rest
 * mount one per task, visible frames first, so the first frame is interactive quickly and no
 * single task renders thousands of nodes. Frames added later (new, duplicated, inserted by the
 * agent) render immediately.
 */
function useLiveFrames(frames: readonly Frame[]): ReadonlySet<string> {
  const canvas = useCanvasStoreApi();
  const [initial] = useState(() => new Set(frames.map((f) => f.id)));
  const [mounted, setMounted] = useState<ReadonlySet<string>>(
    () => new Set(frames.slice(0, 1).map((f) => f.id)),
  );
  const framesRef = useRef(frames);
  useLayoutEffect(() => {
    framesRef.current = frames;
  });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = mounted;
    const step = () => {
      const pending = framesRef.current.filter((f) => initial.has(f.id) && !done.has(f.id));
      if (!pending.length) return;
      const { camera, viewport, sizes } = canvas.getState();
      const view = viewportWorldRect(camera, viewport);
      const cx = view.x + view.width / 2;
      const cy = view.y + view.height / 2;
      // Visible frames first, then nearest to the viewport centre.
      const score = (f: Frame) => {
        const r = frameRect(f, sizes);
        const dist = Math.hypot(r.x + r.width / 2 - cx, r.y + r.height / 2 - cy);
        return intersects(r, view) ? dist - 1e9 : dist;
      };
      const next = pending.reduce((a, b) => (score(b) < score(a) ? b : a));
      done = new Set(done).add(next.id);
      setMounted(done);
      timer = setTimeout(step, 16);
    };
    timer = setTimeout(step, 16);
    return () => {
      if (timer) clearTimeout(timer);
    };
    // Runs once: the mounted set is threaded through `done`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas, initial]);

  return useMemo(() => {
    const live = new Set(mounted);
    for (const f of frames) if (!initial.has(f.id)) live.add(f.id);
    return live;
  }, [frames, mounted, initial]);
}

/** True if anything a frame renders differs between two docs (identity walk, thanks to immer). */
export function frameChanged(prev: DesignDoc, next: DesignDoc, frameId: string): boolean {
  if (prev === next) return false;
  if (prev.tokenOverrides !== next.tokenOverrides) return true;
  const f = next.frames.find((x) => x.id === frameId);
  if (!f || prev.frames.find((x) => x.id === frameId) !== f) return true;
  const stack = [f.rootNodeId];
  while (stack.length) {
    const id = stack.pop()!;
    const n = next.nodes[id];
    if (n !== prev.nodes[id]) return true; // a removed child shows up as a changed parent
    if (n) for (const c of n.children) stack.push(c);
  }
  return false;
}

/**
 * Per-frame doc snapshots (Story 3.10): a frame keeps receiving its previous doc object until an
 * edit touches something it renders, so an edit in one frame doesn't make every other frame's
 * renderer re-check all of its nodes.
 */
function useFrameDocs(doc: DesignDoc): ReadonlyMap<string, DesignDoc> {
  const [cache, setCache] = useState(() => ({
    doc,
    map: new Map(doc.frames.map((f) => [f.id, doc])) as ReadonlyMap<string, DesignDoc>,
  }));
  if (cache.doc === doc) return cache.map;
  const map = new Map<string, DesignDoc>();
  for (const f of doc.frames) {
    const prev = cache.map.get(f.id);
    map.set(f.id, prev && !frameChanged(prev, doc, f.id) ? prev : doc);
  }
  // Adjusting state during render (React's documented pattern for derived state).
  setCache({ doc, map });
  return map;
}

const FrameItem = memo(function FrameItem({
  frame,
  doc,
  ds,
  live,
}: {
  frame: Frame;
  doc: DesignDoc;
  ds: DesignSystemSpec;
  live: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const canvas = useCanvasStoreApi();
  const preview = useCanvas((s) => (s.framePreview?.frameId === frame.id ? s.framePreview : null));
  const placeholderHeight = useCanvas((s) =>
    live
      ? undefined
      : (s.sizes[frame.id]?.height ?? (frame.height === 'auto' ? 800 : frame.height)),
  );

  // Measure the frame (auto-height frames grow with content) for chrome, fit and minimap.
  useLayoutEffect(() => {
    if (!live) return;
    const el = ref.current!;
    const measure = () => {
      canvas.getState().setSize(frame.id, { width: el.offsetWidth, height: el.offsetHeight });
      markFirstFrame(el);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [canvas, frame.id, live]);

  // Width preview: the renderer pins `.cd-frame` to the frame width inside the shadow root.
  const previewWidth = preview?.width;
  useLayoutEffect(() => {
    const inner = ref.current
      ?.querySelector('[data-cd-frame-host]')
      ?.shadowRoot?.querySelector<HTMLElement>('.cd-frame');
    if (inner) inner.style.width = previewWidth ? `${previewWidth}px` : '';
  }, [previewWidth]);

  return (
    <div
      ref={ref}
      data-cd-frame-wrap={frame.id}
      style={{
        position: 'absolute',
        left: frame.canvas.x + (preview?.dx ?? 0),
        top: frame.canvas.y + (preview?.dy ?? 0),
        width: previewWidth ?? frame.width,
        minHeight: frame.height === 'auto' ? undefined : frame.height,
        height: placeholderHeight,
        background: '#fff',
        boxShadow: '0 1px 3px rgba(0,0,0,.08), 0 0 0 1px rgba(0,0,0,.06)',
        contain: 'layout paint',
      }}
    >
      {live && <FrameView doc={doc} ds={ds} frameId={frame.id} />}
    </div>
  );
});

/** World layer: frames at their canvas positions, transformed by the camera without re-rendering. */
function World({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const canvas = useCanvasStoreApi();
  useLayoutEffect(() => {
    const apply = (c: Camera) => {
      if (ref.current) ref.current.style.transform = cameraTransform(c);
    };
    apply(canvas.getState().camera);
    return canvas.subscribe((s, prev) => {
      if (s.camera !== prev.camera) apply(s.camera);
    });
  }, [canvas]);
  return (
    <div
      ref={ref}
      data-cd-world=""
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        transformOrigin: '0 0',
        willChange: 'transform',
      }}
    >
      {children}
    </div>
  );
}

function useViewport(ref: React.RefObject<HTMLDivElement | null>) {
  const canvas = useCanvasStoreApi();
  const docStore = useDocStoreApi();
  useLayoutEffect(() => {
    const el = ref.current!;
    let scheduled = false;
    const measure = () => {
      const r = el.getBoundingClientRect();
      canvas.getState().setViewport({ width: r.width, height: r.height });
      const st = canvas.getState();
      if (!st.fitted && !scheduled && r.width > 0 && docStore.getState().doc.frames.length) {
        scheduled = true;
        // Frames portal into their shadow roots after mount; fit once they've been measured.
        // `fitted` flips only after the camera has moved, so "fitted" means positions are final.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            fitAll(canvas, docStore.getState().doc);
            canvas.getState().setFitted();
          }),
        );
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, canvas, docStore]);
}

/** Wheel pan/zoom, background and middle-button drag pan, space-drag pan. */
function useCameraGestures(ref: React.RefObject<HTMLDivElement | null>) {
  const canvas = useCanvasStoreApi();
  const space = useRef(false);
  useEffect(() => {
    const el = ref.current!;
    const local = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const st = canvas.getState();
      st.setCamera(wheelCamera(st.camera, e, local(e)));
    };
    const onDown = (e: PointerEvent) => {
      const path = e.composedPath();
      const onBackground =
        path[0] === el || (path[0] as HTMLElement)?.dataset?.cdWorld !== undefined;
      if (!(e.button === 1 || (e.button === 0 && (space.current || onBackground)))) return;
      e.preventDefault();
      e.stopPropagation();
      const start = canvas.getState().camera;
      startGesture(e, {
        onStart: () => {
          canvas.getState().setGesture('pan');
          el.style.cursor = 'grabbing';
        },
        onMove: (_e, dx, dy) =>
          canvas.getState().setCamera({ ...start, x: start.x + dx, y: start.y + dy }),
        onEnd: (_e, moved) => {
          // A plain click on empty canvas clears the selection; a drag pans.
          canvas.getState().setGesture(null);
          el.style.cursor = '';
          if (!moved && onBackground) el.dispatchEvent(new CustomEvent('cd-background-click'));
        },
        onCancel: () => {
          canvas.getState().setCamera(start);
          canvas.getState().setGesture(null);
          el.style.cursor = '';
        },
      });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isTypingEvent(e)) return;
      space.current = e.type === 'keydown';
      if (e.type === 'keydown' && el.matches(':hover')) e.preventDefault();
      el.style.cursor = space.current ? 'grab' : '';
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, [ref, canvas]);
}

/**
 * Overlay/chrome components take no props and subscribe to exactly the state they need. Memoizing
 * them keeps a doc edit (which re-renders CanvasPane for the frames) from re-rendering them all.
 */
const UI = {
  SelectionOverlay: memo(SelectionOverlay),
  DropIndicator: memo(DropIndicator),
  GuidesOverlay: memo(GuidesOverlay),
  ResizeHandles: memo(ResizeHandles),
  FrameChrome: memo(FrameChrome),
  RegisteredOverlays: memo(RegisteredOverlays),
  LayersPanel: memo(LayersPanel),
  CanvasToolbar: memo(CanvasToolbar),
  Minimap: memo(Minimap),
  CanvasMessage: memo(CanvasMessage),
};

export function CanvasPane() {
  const { designSystem } = useEditor();
  const doc = useDocStore((s) => s.doc);
  const live = useLiveFrames(doc.frames);
  const frameDocs = useFrameDocs(doc);
  const select = useDocStore((s) => s.select);
  const viewportRef = useRef<HTMLDivElement>(null);
  useViewport(viewportRef);
  useCameraGestures(viewportRef);
  useSelectionInput(viewportRef);
  useEditLockLoop();

  useEffect(() => {
    const el = viewportRef.current!;
    const clear = () => select({ nodeIds: [], frameId: null });
    el.addEventListener('cd-background-click', clear);
    return () => el.removeEventListener('cd-background-click', clear);
  }, [select]);

  return (
    <ViewportCtx.Provider value={viewportRef}>
      <div
        ref={viewportRef}
        data-testid="canvas"
        className="bg-surface-2"
        tabIndex={-1}
        style={{
          position: 'relative',
          height: '100%',
          overflow: 'hidden',
          touchAction: 'none',
          userSelect: 'none',
          outline: 'none',
        }}
      >
        <World>
          {doc.frames.map((f) => (
            <FrameItem
              key={f.id}
              frame={f}
              doc={frameDocs.get(f.id) ?? doc}
              ds={designSystem.spec}
              live={live.has(f.id)}
            />
          ))}
        </World>
        <div
          data-cd-overlay=""
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}
        >
          <UI.SelectionOverlay />
          <UI.DropIndicator />
          <UI.GuidesOverlay />
          <UI.ResizeHandles />
          <UI.FrameChrome />
          <UI.RegisteredOverlays />
        </div>
        <UI.LayersPanel />
        <UI.CanvasToolbar />
        <UI.Minimap />
        <UI.CanvasMessage />
      </div>
    </ViewportCtx.Provider>
  );
}
