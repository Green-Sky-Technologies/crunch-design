'use client';

/** Comments drawer (Story 6.1): composer for the selected element, thread list, replies, resolve. */
import type { DesignDoc } from '@crunch/doc-model';
import { useState } from 'react';
import { useDocStore, useEditor } from '../doc-store';
import { commentsApi, memberLabel, type Anchor, type Thread } from './api';
import { MentionInput, useMembers } from './mention-input';
import { pinAnchorPoint } from './anchor';
import { overlayToCanvas, useCollab } from './store';

export function nodeLabel(doc: DesignDoc, nodeId: string): string {
  const n = doc.nodes[nodeId];
  if (!n) return 'Deleted element';
  if (n.name) return n.name;
  if (n.type === 'text') {
    const t = n.props.text.trim();
    return t ? `“${t.length > 28 ? `${t.slice(0, 28)}…` : t}”` : 'Text';
  }
  return n.type === 'box' ? `<${n.tag}>` : n.type[0]!.toUpperCase() + n.type.slice(1);
}

export function anchorLabel(doc: DesignDoc, a: Anchor, currentFrameId?: string | null): string {
  if (a.type === 'canvas') return 'Canvas';
  const fid = currentFrameId ?? a.frameId;
  const frame = doc.frames.find((f) => f.id === fid);
  return `${frame?.name ?? 'Frame'} › ${nodeLabel(doc, a.nodeId)}`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const fmtTime = (iso: string) => timeFmt.format(new Date(iso));

/** Where a new comment goes: the selected node, or the current frame's top-left corner on the canvas. */
function useComposerTarget(): {
  anchor: Anchor;
  label: string;
  fallback?: { x: number; y: number };
} | null {
  const doc = useDocStore((s) => s.doc);
  const selection = useDocStore((s) => s.selection);
  const api = useCollab((s) => s.overlayApi);
  const nodeId = selection.nodeIds[0];
  const frameId = selection.frameId ?? doc.frames[0]?.id ?? null;
  if (nodeId && frameId && doc.nodes[nodeId]) {
    const rect = api?.getNodeRect(nodeId, frameId);
    return {
      anchor: { type: 'node', frameId, nodeId },
      label: anchorLabel(doc, { type: 'node', frameId, nodeId }),
      // Same point the pin is drawn at (node's top-right), so an orphaned pin stays in place.
      fallback: rect && api ? overlayToCanvas(api, pinAnchorPoint(rect)) : undefined,
    };
  }
  const frame = doc.frames.find((f) => f.id === frameId);
  if (!frame) return null;
  return {
    anchor: { type: 'canvas', x: frame.canvas.x, y: frame.canvas.y },
    label: `Canvas (${frame.name})`,
  };
}

export interface ComposerExtras {
  /** Render extra composer controls (ask-agent toggle) for the current target. */
  renderExtra?: (anchor: Anchor) => React.ReactNode;
  /** Called with the created thread; may start follow-up work (ask-agent). */
  kind?: 'discussion' | 'agent_request';
  afterCreate?: (t: Thread) => void;
}

function Composer({ extras }: { extras?: ComposerExtras }) {
  const { project } = useEditor();
  const target = useComposerTarget();
  const upsert = useCollab((s) => s.upsertThread);
  const focus = useCollab((s) => s.focusThread);
  const [error, setError] = useState<string | null>(null);
  if (!target) return null;
  // Only element-pinned comments can be sent to the agent (it edits that node's subtree).
  const kind = target.anchor.type === 'node' ? (extras?.kind ?? 'discussion') : 'discussion';
  return (
    <div className="border-b border-border p-3">
      <div className="mb-2 text-xs text-muted">
        Commenting on <span className="font-medium text-text">{target.label}</span>
        {target.anchor.type === 'canvas' && ' · select an element to pin to it'}
      </div>
      <MentionInput
        placeholder="Add a comment… use @ to mention"
        submitLabel={kind === 'agent_request' ? 'Ask agent' : 'Comment'}
        extra={extras?.renderExtra?.(target.anchor)}
        onSubmit={async (body, mentions) => {
          setError(null);
          try {
            const { thread } = await commentsApi.create({
              projectId: project.id,
              anchor: target.anchor,
              body,
              mentions,
              kind,
              fallback: target.fallback,
            });
            upsert(thread);
            focus(thread.id);
            if (kind === 'agent_request') extras?.afterCreate?.(thread);
            return true;
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not post comment');
            return false;
          }
        }}
      />
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

export interface ThreadExtras {
  /** Extra content under a thread's comments (ask-agent status). */
  renderThreadExtra?: (t: Thread) => React.ReactNode;
}

function ThreadCard({ t, extras }: { t: Thread; extras?: ThreadExtras }) {
  const { can } = useEditor();
  const doc = useDocStore((s) => s.doc);
  const select = useDocStore((s) => s.select);
  const members = useMembers();
  const focused = useCollab((s) => s.focusedThreadId === t.id);
  const focus = useCollab((s) => s.focusThread);
  const upsert = useCollab((s) => s.upsertThread);
  const [error, setError] = useState<string | null>(null);
  const canComment = can('design:comment');
  const byId = new Map(members.map((m) => [m.userId, m]));

  const goTo = () => {
    focus(t.id);
    if (t.anchor.type === 'node' && !t.orphaned)
      select({ frameId: t.currentFrameId ?? t.anchor.frameId, nodeIds: [t.anchor.nodeId] });
  };

  return (
    <li
      className={`border-b border-border p-3 ${focused ? 'bg-surface-2' : ''} ${t.status === 'resolved' ? 'opacity-70' : ''}`}
      data-thread-id={t.id}
    >
      <div className="mb-2 flex items-center gap-2 text-xs">
        <button className="truncate text-left text-muted hover:text-text" onClick={goTo}>
          {anchorLabel(doc, t.anchor, t.currentFrameId)}
        </button>
        {t.kind === 'agent_request' && (
          <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
            Ask agent
          </span>
        )}
        {t.orphaned && (
          <span
            className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted"
            title="The element was deleted; the thread is kept at its last position"
          >
            Element deleted
          </span>
        )}
        {canComment && (
          <button
            className="ml-auto shrink-0 text-muted hover:text-text"
            onClick={async () => {
              try {
                const r = await commentsApi.setStatus(
                  t.id,
                  t.status === 'open' ? 'resolved' : 'open',
                );
                upsert(r.thread);
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Failed');
              }
            }}
          >
            {t.status === 'open' ? 'Resolve' : 'Reopen'}
          </button>
        )}
      </div>
      <ol className="space-y-2">
        {t.comments.map((c) => (
          <li key={c.id} className="text-sm">
            <div className="text-xs text-muted">
              <span className="font-medium text-text">
                {c.authorType === 'agent'
                  ? 'Agent'
                  : (c.authorName ?? memberLabel(byId.get(c.authorId)))}
              </span>{' '}
              · {fmtTime(c.createdAt)}
            </div>
            <p className="whitespace-pre-wrap break-words">{c.body}</p>
          </li>
        ))}
      </ol>
      {extras?.renderThreadExtra?.(t)}
      {focused && canComment && t.status === 'open' && (
        <div className="mt-2">
          <MentionInput
            placeholder="Reply…"
            submitLabel="Reply"
            autoFocus
            onSubmit={async (body, mentions) => {
              setError(null);
              try {
                const r = await commentsApi.reply(t.id, { body, mentions });
                upsert(r.thread);
                return true;
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not reply');
                return false;
              }
            }}
          />
        </div>
      )}
      {!focused && t.status === 'open' && canComment && (
        <button className="mt-1 text-xs text-muted hover:text-text" onClick={goTo}>
          Reply
        </button>
      )}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </li>
  );
}

export function CommentsPanel({
  composerExtras,
  threadExtras,
}: {
  composerExtras?: ComposerExtras;
  threadExtras?: ThreadExtras;
}) {
  const { can } = useEditor();
  const threads = useCollab((s) => s.threads);
  const loaded = useCollab((s) => s.loaded);
  const loadError = useCollab((s) => s.loadError);
  const showResolved = useCollab((s) => s.showResolved);
  const setShowResolved = useCollab((s) => s.setShowResolved);
  const visible = threads.filter((t) => showResolved || t.status === 'open');

  return (
    <div className="flex h-full flex-col">
      {can('design:comment') ? (
        <Composer extras={composerExtras} />
      ) : (
        <p className="border-b border-border p-3 text-xs text-muted">
          You have view-only access, so you can read comments but not add them.
        </p>
      )}
      <label className="flex items-center gap-2 px-3 py-2 text-xs text-muted">
        <input
          type="checkbox"
          checked={showResolved}
          onChange={(e) => setShowResolved(e.target.checked)}
        />
        Show resolved
      </label>
      <ul className="min-h-0 flex-1 overflow-auto">
        {!loaded && <li className="p-3 text-sm text-muted">Loading…</li>}
        {loadError && <li className="p-3 text-sm text-danger">{loadError}</li>}
        {loaded && !visible.length && !loadError && (
          <li className="p-3 text-sm text-muted">No comments yet.</li>
        )}
        {visible.map((t) => (
          <ThreadCard key={t.id} t={t} extras={threadExtras} />
        ))}
      </ul>
    </div>
  );
}
