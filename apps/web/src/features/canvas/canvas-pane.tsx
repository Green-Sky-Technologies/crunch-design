'use client';

/**
 * The infinite canvas (Story 3.1, ADR 0001): a viewport with a CSS-transformed world layer of
 * live frames, and a screen-space overlay layer above it for frame chrome and selection UI.
 */
import { cameraTransform, wheelCamera, type Camera } from '@crunch/canvas';
import type { DesignDoc, DesignSystemSpec, Frame } from '@crunch/doc-model';
import { FrameView } from '@crunch/renderer/react';
import { memo, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useDocStore, useDocStoreApi, useEditor } from '../doc-store';
import { fitAll } from './camera-actions';
import { useCanvas, useCanvasStoreApi } from './canvas-store';
import { ViewportCtx } from './context';
import { FrameChrome } from './frame-chrome';
import { LayersPanel } from './layers-panel';
import { RegisteredOverlays } from './overlay-api';
import { useSelectionInput } from './selection-input';
import { DropIndicator, SelectionOverlay } from './selection-overlay';
import { isTypingEvent, startGesture } from './gesture';
import { Minimap } from './minimap';
import { CanvasToolbar } from './toolbar';

const FrameItem = memo(function FrameItem({
  frame,
  doc,
  ds,
}: {
  frame: Frame;
  doc: DesignDoc;
  ds: DesignSystemSpec;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const canvas = useCanvasStoreApi();
  const preview = useCanvas((s) => (s.framePreview?.frameId === frame.id ? s.framePreview : null));

  // Measure the frame (auto-height frames grow with content) for chrome, fit and minimap.
  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () =>
      canvas.getState().setSize(frame.id, { width: el.offsetWidth, height: el.offsetHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [canvas, frame.id]);

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
        background: '#fff',
        boxShadow: '0 1px 3px rgba(0,0,0,.08), 0 0 0 1px rgba(0,0,0,.06)',
        contain: 'layout paint',
      }}
    >
      <FrameView doc={doc} ds={ds} frameId={frame.id} />
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
    const measure = () => {
      const r = el.getBoundingClientRect();
      canvas.getState().setViewport({ width: r.width, height: r.height });
      const st = canvas.getState();
      if (!st.fitted && r.width > 0 && docStore.getState().doc.frames.length) {
        st.setFitted();
        // Frames portal into their shadow roots after mount; fit once they've been measured.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => fitAll(canvas, docStore.getState().doc)),
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

export function CanvasPane() {
  const { designSystem } = useEditor();
  const doc = useDocStore((s) => s.doc);
  const select = useDocStore((s) => s.select);
  const viewportRef = useRef<HTMLDivElement>(null);
  useViewport(viewportRef);
  useCameraGestures(viewportRef);
  useSelectionInput(viewportRef);

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
            <FrameItem key={f.id} frame={f} doc={doc} ds={designSystem.spec} />
          ))}
        </World>
        <div
          data-cd-overlay=""
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}
        >
          <SelectionOverlay />
          <DropIndicator />
          <FrameChrome />
          <RegisteredOverlays />
        </div>
        <LayersPanel />
        <CanvasToolbar />
        <Minimap />
      </div>
    </ViewportCtx.Provider>
  );
}
