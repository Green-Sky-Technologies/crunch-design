'use client';

/**
 * Collaboration controls in the editor top bar (Epic 6): comments (6.1), notifications.
 * Reads everything from useEditor() / useDocStore(); no props (editor-shell slot).
 */
import { useEffect } from 'react';
import { useEditor } from '../doc-store';
import { useCommentPinsOverlay } from './comment-pins';
import { CommentsPanel } from './comments-panel';
import { Drawer } from './drawer';
import { NotificationsBell } from './notifications';
import { useCollab } from './store';

const THREAD_POLL_MS = 15_000;

function useThreadSync(projectId: string) {
  const load = useCollab((s) => s.load);
  useEffect(() => {
    void load(projectId);
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void load(projectId);
    }, THREAD_POLL_MS);
    return () => clearInterval(id);
  }, [projectId, load]);
}

export function CollabControls() {
  const { project } = useEditor();
  const panel = useCollab((s) => s.panel);
  const toggle = useCollab((s) => s.togglePanel);
  const openCount = useCollab((s) => s.threads.filter((t) => t.status === 'open').length);
  useThreadSync(project.id);
  useCommentPinsOverlay();

  return (
    <>
      <button
        className={`btn-ghost px-2 py-1 ${panel === 'comments' ? 'bg-surface-2' : ''}`}
        aria-pressed={panel === 'comments'}
        onClick={() => toggle('comments')}
      >
        Comments{openCount ? ` (${openCount})` : ''}
      </button>
      <NotificationsBell />
      {panel === 'comments' && (
        <Drawer title="Comments">
          <CommentsPanel />
        </Drawer>
      )}
    </>
  );
}
