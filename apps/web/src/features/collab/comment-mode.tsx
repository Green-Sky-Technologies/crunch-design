'use client';

/**
 * Comment mode: hover outlines an element, clicking it opens a small composer pinned there with
 * two actions. "Comment" posts a human comment thread (shown in the comments pane over the chat);
 * "Send to agent" posts the text into the open agent chat with the element as context.
 */
import type { OverlayApi, OverlayRect } from '@crunch/contracts/canvas-overlay';
import { registerOverlay } from '@crunch/contracts/canvas-overlay';
import { useEffect, useReducer, useRef, useState } from 'react';
import { useAgentOutbox } from '../agent/outbox';
import { useCanvas } from '../canvas/canvas-store';
import { hitFromPoint } from '../canvas/dom';
import { useDocStore, useEditor } from '../doc-store';
import { pinAnchorPoint } from './anchor';
import { commentsApi } from './api';
import { anchorLabel, nodeLabel } from './comments-panel';
import { overlayToCanvas, useCollab } from './store';

export const COMMENT_MODE_OVERLAY_ID = 'collab.comment-mode';

interface Target {
  frameId: string;
  nodeId: string;
}

/** The node under a client point, looking through the capture layer to the frames below. */
function hitBelow(layer: HTMLElement, x: number, y: number): Target | null {
  const prev = layer.style.pointerEvents;
  layer.style.pointerEvents = 'none';
  try {
    const hit = hitFromPoint(x, y);
    return hit ? { frameId: hit.frameId, nodeId: hit.nodeId } : null;
  } finally {
    layer.style.pointerEvents = prev;
  }
}

function Outline({ rect, strong }: { rect: OverlayRect; strong?: boolean }) {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        pointerEvents: 'none',
      }}
      className={`rounded-[2px] ${strong ? 'outline-2 outline-accent' : 'outline-1 outline-accent/70'} outline`}
    />
  );
}

export function CommentModeLayer({ api }: { api: OverlayApi }) {
  const mode = useCanvas((s) => s.mode);
  // Unmounting on leaving comment mode drops the hover and the open composer.
  return mode === 'comment' ? <CommentModeInner api={api} /> : null;
}

function CommentModeInner({ api }: { api: OverlayApi }) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const layerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Target | null>(null);
  const [target, setTarget] = useState<Target | null>(null);

  useEffect(() => api.subscribe(rerender), [api]);

  const hoverRect = hover && !target ? api.getNodeRect(hover.nodeId, hover.frameId) : null;
  const targetRect = target ? api.getNodeRect(target.nodeId, target.frameId) : null;

  return (
    <>
      <div
        ref={layerRef}
        data-testid="comment-mode-layer"
        style={{ position: 'absolute', inset: 0, pointerEvents: 'auto', cursor: 'crosshair' }}
        onPointerMove={(e) => {
          const h = hitBelow(e.currentTarget, e.clientX, e.clientY);
          setHover((p) => (p?.nodeId === h?.nodeId && p?.frameId === h?.frameId ? p : h));
        }}
        onPointerLeave={() => setHover(null)}
        onPointerDown={(e) => {
          // Left clicks pick an element; middle-drag and space-drag still pan the canvas.
          if (e.button !== 0) return;
          e.stopPropagation();
          const h = hitBelow(e.currentTarget, e.clientX, e.clientY);
          setTarget(h);
        }}
      />
      {hoverRect && <Outline rect={hoverRect} />}
      {target && targetRect && (
        <>
          <Outline rect={targetRect} strong />
          <CommentPopover
            api={api}
            target={target}
            rect={targetRect}
            onClose={() => setTarget(null)}
          />
        </>
      )}
    </>
  );
}

function CommentPopover({
  api,
  target,
  rect,
  onClose,
}: {
  api: OverlayApi;
  target: Target;
  rect: OverlayRect;
  onClose: () => void;
}) {
  const { project, can, agentAvailable } = useEditor();
  const doc = useDocStore((s) => s.doc);
  const upsert = useCollab((s) => s.upsertThread);
  const focus = useCollab((s) => s.focusThread);
  const setPanel = useCollab((s) => s.setPanel);
  const pushToAgent = useAgentOutbox((s) => s.push);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canComment = can('design:comment');
  const canAsk = can('agent:run') && agentAvailable;
  const body = text.trim();

  const comment = async () => {
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const anchor = { type: 'node' as const, frameId: target.frameId, nodeId: target.nodeId };
      const { thread } = await commentsApi.create({
        projectId: project.id,
        anchor,
        body,
        mentions: [],
        kind: 'discussion',
        fallback: overlayToCanvas(api, pinAnchorPoint(rect)),
      });
      upsert(thread);
      focus(thread.id); // opens the comments pane over the chat
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not post the comment');
    } finally {
      setBusy(false);
    }
  };

  const sendToAgent = () => {
    if (!body) return;
    pushToAgent({
      text: body,
      frameId: target.frameId,
      nodeId: target.nodeId,
      label: anchorLabel(doc, { type: 'node', ...target }),
    });
    setPanel(null); // show the chat, where the message lands
    onClose();
  };

  // Below the element when there's room, else above; clamped into the canvas horizontally.
  const below = rect.y + rect.height + 8;
  const style: React.CSSProperties = {
    position: 'absolute',
    left: Math.max(8, rect.x),
    top: below,
    width: 300,
    pointerEvents: 'auto',
  };

  return (
    <div
      role="dialog"
      aria-label="Comment on element"
      className="card z-10 p-2 text-sm shadow-lg"
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <p className="mb-1 truncate px-1 text-xs text-muted">{nodeLabel(doc, target.nodeId)}</p>
      <textarea
        autoFocus
        rows={3}
        className="input w-full resize-none"
        placeholder={canComment ? 'Add a comment…' : 'View-only access'}
        disabled={!canComment && !canAsk}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (e.shiftKey && canAsk) sendToAgent();
            else if (canComment) void comment();
          }
        }}
      />
      {error && <p className="mt-1 px-1 text-xs text-danger">{error}</p>}
      <div className="mt-2 flex items-center justify-end gap-1.5">
        <button type="button" className="btn-ghost mr-auto px-2 py-1 text-xs" onClick={onClose}>
          Cancel
        </button>
        {canComment && (
          <button
            type="button"
            className="btn-ghost border border-border px-2.5 py-1 text-xs"
            disabled={!body || busy}
            onClick={() => void comment()}
            title="Post to the comments (⌘↵)"
          >
            Comment
          </button>
        )}
        {canAsk && (
          <button
            type="button"
            className="btn-primary px-2.5 py-1 text-xs"
            disabled={!body || busy}
            onClick={sendToAgent}
            title="Send to the agent chat (⇧⌘↵)"
          >
            Send to agent
          </button>
        )}
      </div>
    </div>
  );
}

/** Register the comment-mode layer while the editor is mounted (above the pins). */
export function useCommentModeOverlay() {
  useEffect(
    () => registerOverlay({ id: COMMENT_MODE_OVERLAY_ID, order: 40, Component: CommentModeLayer }),
    [],
  );
}
