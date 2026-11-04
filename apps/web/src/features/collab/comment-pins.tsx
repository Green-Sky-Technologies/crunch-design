'use client';

/**
 * Comment pins on the canvas (Story 6.1), rendered by the canvas through the canvas-overlay
 * contract. A node-anchored pin sits at its node's top-right corner and follows it when it
 * moves, including into another frame; an orphaned thread (node deleted) or a canvas thread
 * sits at its canvas position.
 */
import { registerOverlay, type OverlayApi } from '@crunch/contracts/canvas-overlay';
import { useEffect, useReducer, useRef } from 'react';
import type { DesignDoc } from '@crunch/doc-model';
import { frameOfNode, pinAnchorPoint } from './anchor';
import { commentsApi, type Thread } from './api';
import { overlayToCanvas, useCollab } from './store';

export const COMMENT_OVERLAY_ID = 'collab.comment-pins';
/** Fallback positions are re-saved this long after the last pan/zoom/layout change. */
export const FALLBACK_DEBOUNCE_MS = 1500;

/**
 * Where a node anchor lives right now. Uses the live editor doc when available (instant),
 * else the server's view (currentFrameId / orphaned) from the last poll.
 */
export function liveAnchor(
  t: Thread,
  doc: DesignDoc | null,
): { frameId: string | null; orphaned: boolean } {
  if (t.anchor.type !== 'node') return { frameId: null, orphaned: false };
  if (doc) {
    const frameId = frameOfNode(doc, t.anchor.nodeId);
    return { frameId, orphaned: frameId === null };
  }
  return { frameId: t.currentFrameId ?? t.anchor.frameId, orphaned: t.orphaned };
}

/** Overlay position of a live node's pin, or null if the node is orphaned or not rendered. */
function livePinPoint(api: OverlayApi, t: Thread, doc: DesignDoc | null) {
  if (t.anchor.type !== 'node') return null;
  const live = liveAnchor(t, doc);
  if (live.orphaned) return null;
  const r = api.getNodeRect(t.anchor.nodeId, live.frameId ?? undefined);
  if (!r) return null;
  const off = t.anchor.offset ?? { x: 0, y: 0 };
  return pinAnchorPoint(r, { x: off.x * api.zoom, y: off.y * api.zoom });
}

export function pinPosition(
  api: OverlayApi,
  t: Thread,
  doc: DesignDoc | null = null,
): { x: number; y: number } | null {
  if (t.anchor.type === 'canvas') return api.canvasToOverlay({ x: t.anchor.x, y: t.anchor.y });
  const p = livePinPoint(api, t, doc);
  if (p) return p;
  if (!liveAnchor(t, doc).orphaned) return null; // live but not rendered right now
  return t.fallback ? api.canvasToOverlay(t.fallback) : null;
}

/**
 * Keep each live node's fallback equal to its pin's canvas position (debounced after pan, zoom,
 * layout or doc changes), so if the node is deleted the orphaned pin stays exactly where it was.
 */
export function useRefreshFallbacks(
  api: OverlayApi,
  threads: Thread[],
  doc: DesignDoc | null,
  canWrite: boolean,
  save: (
    threadId: string,
    p: { x: number; y: number },
  ) => Promise<unknown> = commentsApi.setFallback,
) {
  const saved = useRef(new Map<string, { x: number; y: number }>());
  const latest = useRef({ threads, doc });
  useEffect(() => {
    latest.current = { threads, doc };
  });
  useEffect(() => {
    if (!canWrite) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      const { threads: ts, doc: d } = latest.current;
      for (const t of ts) {
        if (t.anchor.type !== 'node' || t.status !== 'open') continue;
        const o = livePinPoint(api, t, d);
        if (!o) continue;
        const p = overlayToCanvas(api, o);
        const prev = saved.current.get(t.id) ?? t.fallback;
        if (prev && Math.abs(prev.x - p.x) < 1 && Math.abs(prev.y - p.y) < 1) continue;
        saved.current.set(t.id, p);
        void save(t.id, p).catch(() => saved.current.delete(t.id));
      }
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, FALLBACK_DEBOUNCE_MS);
    };
    schedule();
    const unsub = api.subscribe(schedule);
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [api, canWrite, save, threads, doc]);
}

export function CommentPins({ api }: { api: OverlayApi }) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const threads = useCollab((s) => s.threads);
  const showResolved = useCollab((s) => s.showResolved);
  const focusedId = useCollab((s) => s.focusedThreadId);
  const focus = useCollab((s) => s.focusThread);
  const setOverlayApi = useCollab((s) => s.setOverlayApi);
  const doc = useCollab((s) => s.doc);

  useEffect(() => api.subscribe(rerender), [api]);
  useEffect(() => {
    setOverlayApi(api);
    return () => setOverlayApi(null);
  }, [api, setOverlayApi]);
  useRefreshFallbacks(api, threads, doc, !api.readOnly);

  const visible = threads.filter((t) => showResolved || t.status === 'open');
  return (
    <>
      {visible.map((t, i) => {
        const p = pinPosition(api, t, doc);
        if (!p) return null;
        const orphaned = liveAnchor(t, doc).orphaned;
        const focused = t.id === focusedId;
        return (
          <button
            key={t.id}
            type="button"
            data-comment-pin={t.id}
            title={t.comments[0]?.body.slice(0, 80) ?? 'Comment'}
            aria-label={`Comment thread ${i + 1}${orphaned ? ' (element deleted)' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              focus(t.id);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              left: p.x,
              top: p.y,
              transform: 'translate(-50%, -100%)',
            }}
            className={`pointer-events-auto flex h-6 min-w-6 items-center justify-center rounded-full rounded-bl-none border-2 border-white px-1 text-[11px] font-semibold shadow-md ${
              t.kind === 'agent_request' ? 'bg-text text-surface' : 'bg-accent text-accent-ink'
            } ${orphaned ? 'opacity-60' : ''} ${focused ? 'ring-2 ring-accent ring-offset-1' : ''}`}
          >
            {t.comments.length}
          </button>
        );
      })}
    </>
  );
}

/** Register the pins overlay while the editor is mounted. */
export function useCommentPinsOverlay() {
  useEffect(
    () => registerOverlay({ id: COMMENT_OVERLAY_ID, order: 50, Component: CommentPins }),
    [],
  );
}
