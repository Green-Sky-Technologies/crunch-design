'use client';

/**
 * Comment pins on the canvas (Story 6.1), rendered by the canvas through the canvas-overlay
 * contract. A node-anchored pin sits at its node's top-right corner and follows it when it
 * moves; an orphaned thread (node deleted) or a canvas thread sits at its canvas position.
 */
import { registerOverlay, type OverlayApi } from '@crunch/contracts/canvas-overlay';
import { useEffect, useReducer, useRef } from 'react';
import { commentsApi, type Thread } from './api';
import { overlayToCanvas, useCollab } from './store';

export const COMMENT_OVERLAY_ID = 'collab.comment-pins';

export function pinPosition(api: OverlayApi, t: Thread): { x: number; y: number } | null {
  if (t.anchor.type === 'node' && !t.orphaned) {
    const r = api.getNodeRect(t.anchor.nodeId, t.anchor.frameId);
    if (r) {
      const off = t.anchor.offset ?? { x: 0, y: 0 };
      return { x: r.x + r.width + off.x * api.zoom, y: r.y + off.y * api.zoom };
    }
  }
  if (t.anchor.type === 'canvas') return api.canvasToOverlay({ x: t.anchor.x, y: t.anchor.y });
  return t.fallback ? api.canvasToOverlay(t.fallback) : null;
}

/** Remember a node's canvas position once per thread per session, so deletion keeps it in place. */
function useRefreshFallbacks(api: OverlayApi, threads: Thread[], canWrite: boolean) {
  const done = useRef(new Set<string>());
  useEffect(() => {
    if (!canWrite) return;
    for (const t of threads) {
      if (t.anchor.type !== 'node' || t.orphaned || done.current.has(t.id)) continue;
      const r = api.getNodeRect(t.anchor.nodeId, t.anchor.frameId);
      if (!r) continue;
      done.current.add(t.id);
      const p = overlayToCanvas(api, { x: r.x, y: r.y });
      const fb = t.fallback;
      if (!fb || Math.hypot(fb.x - p.x, fb.y - p.y) > 24)
        void commentsApi.setFallback(t.id, p).catch(() => {});
    }
  }, [api, threads, canWrite]);
}

export function CommentPins({ api }: { api: OverlayApi }) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const threads = useCollab((s) => s.threads);
  const showResolved = useCollab((s) => s.showResolved);
  const focusedId = useCollab((s) => s.focusedThreadId);
  const focus = useCollab((s) => s.focusThread);
  const setOverlayApi = useCollab((s) => s.setOverlayApi);

  useEffect(() => api.subscribe(rerender), [api]);
  useEffect(() => {
    setOverlayApi(api);
    return () => setOverlayApi(null);
  }, [api, setOverlayApi]);
  useRefreshFallbacks(api, threads, !api.readOnly);

  const visible = threads.filter((t) => showResolved || t.status === 'open');
  return (
    <>
      {visible.map((t, i) => {
        const p = pinPosition(api, t);
        if (!p) return null;
        const focused = t.id === focusedId;
        return (
          <button
            key={t.id}
            type="button"
            data-comment-pin={t.id}
            title={t.comments[0]?.body.slice(0, 80) ?? 'Comment'}
            aria-label={`Comment thread ${i + 1}${t.orphaned ? ' (element deleted)' : ''}`}
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
            } ${t.orphaned ? 'opacity-60' : ''} ${focused ? 'ring-2 ring-accent ring-offset-1' : ''}`}
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
