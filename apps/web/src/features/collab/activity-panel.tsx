'use client';

/** Project activity feed (Story 6.4): who changed what, human vs. agent. */
import { useEffect, useState } from 'react';
import { useEditor } from '../doc-store';
import { request } from './api';
import { fmtTime } from './comments-panel';
import { useCollab } from './store';

export interface FeedItem {
  id: string;
  at: string;
  actorType: 'user' | 'agent' | 'system';
  actorId: string;
  actorName: string | null;
  verb: string;
  targetType: string | null;
  targetId: string | null;
  data: Record<string, unknown>;
  edits?: {
    count: number;
    sources: string[];
    labels: string[];
    fromVersion: number;
    toVersion: number;
  };
}

type Who = 'all' | 'human' | 'agent';

const SOURCE_LABEL: Record<string, string> = {
  canvas: 'canvas',
  inspector: 'inspector',
  slider: 'sliders',
  agent: 'agent',
  restore: 'restore',
  import: 'import',
  system: 'system',
};

/** One-line description of an entry (exported for tests). */
export function describeEntry(e: FeedItem): string {
  const s = (k: string) => (typeof e.data[k] === 'string' ? (e.data[k] as string) : '');
  switch (e.verb) {
    case 'doc.edited': {
      const n = e.edits?.count ?? 1;
      const via = (e.edits?.sources ?? []).map((x) => SOURCE_LABEL[x] ?? x).join(', ');
      const labels = e.edits?.labels.length ? `: ${e.edits.labels.join(', ')}` : '';
      return `edited the design (${n} change${n === 1 ? '' : 's'} via ${via})${labels}`;
    }
    case 'comment.created':
      return `commented: “${s('excerpt')}”`;
    case 'comment.replied':
      return `replied: “${s('excerpt')}”`;
    case 'comment.resolved':
      return 'resolved a comment thread';
    case 'comment.reopened':
      return 'reopened a comment thread';
    case 'comment.agent_requested':
      return `asked the agent: “${s('excerpt')}”`;
    case 'version.named':
      return `saved version “${s('name')}”`;
    case 'version.restored':
      return `restored ${s('name') ? `version “${s('name')}”` : 'an automatic snapshot'}`;
    case 'share.created':
      return `created a ${s('visibility') === 'public' ? 'public' : 'workspace'} share link`;
    case 'share.updated':
      return `changed a share link to ${s('visibility') === 'public' ? 'public' : 'workspace-only'}`;
    case 'share.revoked':
      return 'revoked a share link';
    case 'export.created':
      return `exported ${s('format').toUpperCase() || 'the design'}`;
    default:
      return e.verb;
  }
}

function who(e: FeedItem): string {
  const name = e.actorName ?? 'A member';
  if (e.actorType === 'agent') return `Agent (for ${name})`;
  if (e.actorType === 'system') return 'System';
  return name;
}

export function ActivityPanel() {
  const { project } = useEditor();
  const focus = useCollab((s) => s.focusThread);
  const [filter, setFilter] = useState<Who>('all');
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const url = (cursor?: string) =>
    `/api/versions/activity?projectId=${encodeURIComponent(project.id)}&who=${filter}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;

  useEffect(() => {
    let live = true;
    request<{ entries: FeedItem[]; nextCursor: string | null }>(
      `/api/versions/activity?projectId=${encodeURIComponent(project.id)}&who=${filter}`,
    )
      .then((r) => {
        if (!live) return;
        setItems(r.entries);
        setNext(r.nextCursor);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Failed to load'));
    return () => {
      live = false;
    };
  }, [project.id, filter]);

  const more = async () => {
    if (!next) return;
    setLoadingMore(true);
    try {
      const r = await request<{ entries: FeedItem[]; nextCursor: string | null }>(url(next));
      setItems((xs) => [...(xs ?? []), ...r.entries]);
      setNext(r.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div>
      <div className="flex gap-1 border-b border-border p-2" role="tablist">
        {(['all', 'human', 'agent'] as const).map((w) => (
          <button
            key={w}
            role="tab"
            aria-selected={filter === w}
            className={`rounded px-2 py-1 text-xs ${filter === w ? 'bg-surface-2 font-medium' : 'text-muted'}`}
            onClick={() => {
              setItems(null);
              setFilter(w);
            }}
          >
            {w === 'all' ? 'All' : w === 'human' ? 'People' : 'Agent'}
          </button>
        ))}
      </div>
      {error && <p className="p-3 text-xs text-danger">{error}</p>}
      <ol>
        {items === null && <li className="p-3 text-muted">Loading…</li>}
        {items?.length === 0 && <li className="p-3 text-muted">No activity yet.</li>}
        {items?.map((e) => (
          <li
            key={e.id}
            className="flex gap-2 border-b border-border p-3"
            data-actor-type={e.actorType}
          >
            <span
              aria-hidden="true"
              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${e.actorType === 'agent' ? 'bg-accent' : 'bg-muted'}`}
            />
            <div className="min-w-0">
              <p className="break-words">
                <span className="font-medium">{who(e)}</span> {describeEntry(e)}
              </p>
              <div className="text-xs text-muted">
                {fmtTime(e.at)}
                {e.edits &&
                  ` · v${e.edits.fromVersion}${e.edits.toVersion !== e.edits.fromVersion ? `–v${e.edits.toVersion}` : ''}`}
                {e.targetType === 'comment_thread' && e.targetId && (
                  <button className="ml-2 underline" onClick={() => focus(e.targetId ?? null)}>
                    View thread
                  </button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
      {next && (
        <button className="btn-ghost m-3" disabled={loadingMore} onClick={() => void more()}>
          {loadingMore ? 'Loading…' : 'Load older'}
        </button>
      )}
    </div>
  );
}
