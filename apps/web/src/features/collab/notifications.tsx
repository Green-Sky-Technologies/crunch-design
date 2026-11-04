'use client';

/** In-app notification bell (mentions, Story 6.1). Polls while the tab is visible. */
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useEditor } from '../doc-store';
import { commentsApi, memberLabel, type Notification } from './api';
import { fmtTime } from './comments-panel';
import { useMembers } from './mention-input';
import { useCollab } from './store';

const POLL_MS = 30_000;

export function NotificationsBell() {
  const { project, workspace } = useEditor();
  const [items, setItems] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const focus = useCollab((s) => s.focusThread);
  const members = useMembers();
  const byId = new Map(members.map((m) => [m.userId, m]));

  const refresh = useCallback(async () => {
    try {
      setItems((await commentsApi.notifications()).notifications);
    } catch {
      // keep the last list; this is best-effort
    }
  }, []);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const unread = items.filter((n) => !n.readAt);
  const markRead = async (ids: string[] | 'all') => {
    const now = new Date().toISOString();
    setItems((xs) =>
      xs.map((n) => (ids === 'all' || ids.includes(n.id) ? { ...n, readAt: n.readAt ?? now } : n)),
    );
    await commentsApi.markRead(ids).catch(() => {});
  };

  return (
    <div className="relative">
      <button
        className="btn-ghost relative px-2 py-1"
        aria-label={`Notifications${unread.length ? ` (${unread.length} unread)` : ''}`}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9Zm4 10a2 2 0 0 0 4 0"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {unread.length > 0 && (
          <span className="absolute -right-1 -top-1 rounded-full bg-accent px-1 text-[10px] leading-4 text-accent-ink">
            {unread.length}
          </span>
        )}
      </button>
      {open && (
        <div className="card absolute right-0 z-50 mt-1 w-80 shadow-lg">
          <div className="flex items-center border-b border-border px-3 py-2 text-xs">
            <span className="font-medium">Notifications</span>
            {unread.length > 0 && (
              <button
                className="ml-auto text-muted hover:text-text"
                onClick={() => void markRead('all')}
              >
                Mark all read
              </button>
            )}
          </div>
          <ul className="max-h-80 overflow-auto text-sm">
            {!items.length && <li className="p-3 text-muted">Nothing yet.</li>}
            {items.map((n) => {
              const who = memberLabel(byId.get(n.data.by ?? ''));
              const text = (
                <>
                  <span className="font-medium">{who}</span> mentioned you
                  {n.data.excerpt ? `: “${n.data.excerpt}”` : ''}
                  <div className="text-xs text-muted">{fmtTime(n.createdAt)}</div>
                </>
              );
              const cls = `block w-full px-3 py-2 text-left hover:bg-surface-2 ${n.readAt ? 'text-muted' : ''}`;
              return (
                <li key={n.id}>
                  {n.projectId === project.id ? (
                    <button
                      className={cls}
                      onClick={() => {
                        void markRead([n.id]);
                        if (n.data.threadId) focus(n.data.threadId);
                        setOpen(false);
                      }}
                    >
                      {text}
                    </button>
                  ) : n.projectId ? (
                    <Link
                      className={cls}
                      href={`/w/${workspace.slug}/p/${n.projectId}`}
                      onClick={() => void markRead([n.id])}
                    >
                      {text}
                    </Link>
                  ) : (
                    <div className={cls}>{text}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
