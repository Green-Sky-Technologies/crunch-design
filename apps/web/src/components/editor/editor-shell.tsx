'use client';

/**
 * Editor layout: chat (agent) · canvas · inspector, with a top bar. Owned by foundation.
 * Feature streams fill the slots in src/features/<stream>/index.tsx and never edit this file.
 */
import Link from 'next/link';
import { useEffect } from 'react';
import { AgentPane } from '@/features/agent';
import { CanvasPane, EditLockIndicator, InspectorPane } from '@/features/canvas';
import { CollabControls } from '@/features/collab';
import { useDocStore, useDocStoreApi, useEditor } from '@/features/doc-store';
import { ExportMenu } from '@/features/export';
import { LintBadge } from './lint-badge';

function SaveStatus() {
  const status = useDocStore((s) => s.status);
  const label = {
    idle: 'Saved',
    pending: 'Unsaved changes',
    saving: 'Saving…',
    error: 'Save failed',
    offline: 'Offline, will retry',
  }[status];
  return (
    <span
      className={`text-xs ${status === 'error' || status === 'offline' ? 'text-danger' : 'text-muted'}`}
    >
      {label}
    </span>
  );
}

function Notice() {
  const notice = useDocStore((s) => s.notice);
  const dismiss = useDocStore((s) => s.dismissNotice);
  if (!notice) return null;
  return (
    <div
      role="status"
      className="absolute left-1/2 top-16 z-50 -translate-x-1/2 card flex items-center gap-3 px-4 py-2 text-sm shadow-lg"
    >
      {notice}
      <button className="text-muted hover:text-text" onClick={dismiss} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}

/** Global undo/redo shortcuts (Story 3.7). Ignored while typing in inputs. */
function useUndoShortcuts() {
  const store = useDocStoreApi();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (!(e.metaKey || e.ctrlKey) || (e.key.toLowerCase() !== 'z' && e.key.toLowerCase() !== 'y'))
        return;
      e.preventDefault();
      const s = store.getState();
      if (e.key.toLowerCase() === 'y' || e.shiftKey) s.redo();
      else s.undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);
}

export function EditorShell() {
  const { project, workspace } = useEditor();
  useUndoShortcuts();
  const canUndo = useDocStore((s) => s.canUndo());
  const canRedo = useDocStore((s) => s.canRedo());
  const undo = useDocStore((s) => s.undo);
  const redo = useDocStore((s) => s.redo);

  return (
    <div className="relative flex h-[calc(100dvh-3.5rem)] flex-col">
      <div className="flex h-11 items-center gap-3 border-b border-border bg-surface px-3 text-sm">
        <Link href={`/w/${workspace.slug}`} className="text-muted hover:text-text">
          ← Projects
        </Link>
        <span className="font-medium">{project.name}</span>
        <EditLockIndicator />
        <SaveStatus />
        <div className="ml-auto flex items-center gap-2">
          <button
            className="btn-ghost px-2 py-1"
            onClick={undo}
            disabled={!canUndo}
            aria-label="Undo"
            title="Undo (⌘Z)"
          >
            ↶
          </button>
          <button
            className="btn-ghost px-2 py-1"
            onClick={redo}
            disabled={!canRedo}
            aria-label="Redo"
            title="Redo (⇧⌘Z)"
          >
            ↷
          </button>
          <LintBadge />
          <CollabControls />
          <ExportMenu />
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[320px_1fr_300px]">
        <aside className="min-h-0 overflow-auto border-r border-border bg-surface">
          <AgentPane />
        </aside>
        <section className="min-h-0 min-w-0">
          <CanvasPane />
        </section>
        <aside className="min-h-0 overflow-auto border-l border-border bg-surface">
          <InspectorPane />
        </aside>
      </div>
      <Notice />
    </div>
  );
}
