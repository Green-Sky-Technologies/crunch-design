'use client';

/**
 * Collaboration (Epic 6) for the editor shell: the top-bar controls (comments, versions,
 * activity, share, notifications), the comments pane that slides over the left (chat) pane, and
 * comment mode on the canvas. Reads everything from useEditor() / useDocStore().
 */
import { useEffect } from 'react';
import { useDocStore, useEditor } from '../doc-store';
import { ActivityPanel } from './activity-panel';
import { useCommentModeOverlay } from './comment-mode';
import { useCommentPinsOverlay } from './comment-pins';
import { CommentsPanel } from './comments-panel';
import { Drawer } from './drawer';
import { NotificationsBell } from './notifications';
import { useCollab, type CollabPanel } from './store';
import { SharePanel } from './share-panel';
import { VersionsPanel } from './versions-panel';

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

function PanelButton({
  id,
  children,
}: {
  id: Exclude<CollabPanel, null>;
  children: React.ReactNode;
}) {
  const active = useCollab((s) => s.panel === id);
  const toggle = useCollab((s) => s.togglePanel);
  return (
    <button
      className={`btn-ghost px-2 py-1 ${active ? 'bg-surface-2 text-text' : ''}`}
      aria-pressed={active}
      onClick={() => toggle(id)}
    >
      {children}
    </button>
  );
}

export function CollabControls() {
  const { project, can } = useEditor();
  const panel = useCollab((s) => s.panel);
  const openCount = useCollab((s) => s.threads.filter((t) => t.status === 'open').length);
  useThreadSync(project.id);
  useCommentPinsOverlay();
  useCommentModeOverlay();
  const doc = useDocStore((s) => s.doc);
  const setDoc = useCollab((s) => s.setDoc);
  useEffect(() => {
    setDoc(doc);
  }, [doc, setDoc]);
  useEffect(() => () => setDoc(null), [setDoc]);

  return (
    <>
      <PanelButton id="comments">Comments{openCount ? ` (${openCount})` : ''}</PanelButton>
      <PanelButton id="versions">Versions</PanelButton>
      <PanelButton id="activity">Activity</PanelButton>
      {can('share:manage') && <PanelButton id="share">Share</PanelButton>}
      <NotificationsBell />
      {panel === 'versions' && (
        <Drawer title="Versions">
          <VersionsPanel />
        </Drawer>
      )}
      {panel === 'activity' && (
        <Drawer title="Activity">
          <ActivityPanel />
        </Drawer>
      )}
      {panel === 'share' && (
        <Drawer title="Share">
          <SharePanel />
        </Drawer>
      )}
    </>
  );
}

/**
 * The comments pane: a running log of human comment threads, laid over the left pane (the
 * shell positions it). Renders nothing unless the comments panel is open.
 */
export function CommentsPane() {
  const open = useCollab((s) => s.panel === 'comments');
  const setPanel = useCollab((s) => s.setPanel);
  if (!open) return null;
  return (
    <section
      role="dialog"
      aria-label="Comments"
      className="absolute inset-0 z-20 flex flex-col bg-surface text-sm"
    >
      <div className="flex h-10 shrink-0 items-center border-b border-border px-3">
        <h2 className="font-medium">Comments</h2>
        <button
          className="ml-auto text-muted hover:text-text"
          onClick={() => setPanel(null)}
          aria-label="Close comments"
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <CommentsPanel />
      </div>
    </section>
  );
}
