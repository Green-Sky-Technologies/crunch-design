'use client';

/**
 * Implementation of the canvas-overlay contract (@crunch/contracts/canvas-overlay): the OverlayApi
 * handed to every registered overlay (comment pins, lint badges, agent markers), and the layer
 * that renders them above the frames.
 */
import { frameOfNode, worldToScreen } from '@crunch/canvas';
import {
  useCanvasOverlays,
  type OverlayApi,
  type OverlayRect,
} from '@crunch/contracts/canvas-overlay';
import { useMemo } from 'react';
import { useDocStoreApi, useEditor, type DocStore } from '../doc-store';
import { useCanvasStoreApi, type CanvasStore } from './canvas-store';
import { frameIndex, useViewportRef } from './context';
import { nodeElement, screenRect } from './dom';

export function createOverlayApi(opts: {
  viewport: () => HTMLElement | null;
  canvas: CanvasStore;
  docStore: DocStore;
  projectId: string;
}): OverlayApi {
  const { canvas, docStore } = opts;
  return {
    projectId: opts.projectId,
    get zoom() {
      return canvas.getState().camera.z;
    },
    get readOnly() {
      return docStore.getState().readOnly;
    },
    getNodeRect(nodeId: string, frameId?: string): OverlayRect | null {
      const vp = opts.viewport();
      if (!vp) return null;
      const doc = docStore.getState().doc;
      const fid = frameId ?? frameIndex(doc).get(nodeId) ?? frameOfNode(doc, nodeId)?.id;
      if (!fid) return null;
      const el = nodeElement(vp, fid, nodeId);
      return el ? screenRect(vp, el) : null;
    },
    canvasToOverlay(point) {
      return worldToScreen(canvas.getState().camera, point);
    },
    subscribe(cb) {
      let raf = 0;
      // Doc edits change layout after the frames re-render, so notify on the next frame.
      const later = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(cb);
      };
      const offCanvas = canvas.subscribe((s, p) => {
        if (s.camera !== p.camera || s.viewport !== p.viewport) cb();
        else if (s.layoutTick !== p.layoutTick || s.framePreview !== p.framePreview) later();
      });
      const offDoc = docStore.subscribe((s, p) => {
        if (s.doc !== p.doc) later();
        else if (s.readOnly !== p.readOnly) cb();
      });
      return () => {
        cancelAnimationFrame(raf);
        offCanvas();
        offDoc();
      };
    },
  };
}

/** Renders every registered overlay inside the canvas overlay layer. */
export function RegisteredOverlays() {
  const overlays = useCanvasOverlays();
  const viewport = useViewportRef();
  const canvas = useCanvasStoreApi();
  const docStore = useDocStoreApi();
  const { project } = useEditor();
  const api = useMemo(
    () =>
      createOverlayApi({
        viewport: () => viewport.current,
        canvas,
        docStore,
        projectId: project.id,
      }),
    [viewport, canvas, docStore, project.id],
  );
  return (
    <>
      {overlays.map((o) => (
        <div
          key={o.id}
          data-cd-registered-overlay={o.id}
          style={{ position: 'absolute', inset: 0 }}
        >
          <o.Component api={api} />
        </div>
      ))}
    </>
  );
}
