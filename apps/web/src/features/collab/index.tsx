'use client';

/**
 * Collaboration controls in the editor top bar (Epic 6): comments (6.1) with ask-agent
 * requests (5.7), named versions (6.2), share links (6.3), activity
 * feed (6.4), notifications.
 * Reads everything from useEditor() / useDocStore(); no props (editor-shell slot).
 */
import { useEffect } from 'react';
import { useEditor } from '../doc-store';
import { ActivityPanel } from './activity-panel';
import { useAskAgentExtras } from './ask-agent-ui';
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
      className={`btn-ghost px-2 py-1 ${active ? 'bg-surface-2' : ''}`}
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

  return (
    <>
      <PanelButton id="comments">Comments{openCount ? ` (${openCount})` : ''}</PanelButton>
      <PanelButton id="versions">Versions</PanelButton>
      <PanelButton id="activity">Activity</PanelButton>
      {can('share:manage') && <PanelButton id="share">Share</PanelButton>}
      <NotificationsBell />
      {panel === 'comments' && <CommentsDrawer />}
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

function CommentsDrawer() {
  const askAgent = useAskAgentExtras();
  return (
    <Drawer title="Comments">
      <CommentsPanel composerExtras={askAgent.composer} threadExtras={askAgent.thread} />
    </Drawer>
  );
}
