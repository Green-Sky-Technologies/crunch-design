'use client';

/**
 * Editor layout: a slim top bar (project, View / Edit / Comment modes, collab and export), a
 * left pane and the canvas. The left pane is the agent chat in View and Comment mode and the edit
 * panel in Edit mode; the comments pane slides over it.
 */
import { UserButton } from '@clerk/nextjs';
import Link from 'next/link';
import { useEffect } from 'react';
import { AgentPane } from '@/features/agent';
import {
  CanvasPane,
  EditLockIndicator,
  EditPanel,
  canEnterEdit,
  useCanvas,
  useCanvasStoreApi,
  type EditorMode,
} from '@/features/canvas';
import { CollabControls, CommentsPane } from '@/features/collab';
import { useDocStore, useDocStoreApi, useEditor } from '@/features/doc-store';
import { ExportMenu } from '@/features/export';
import { Logo } from '@/components/logo';
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

const MODES: { id: EditorMode; label: string; key: string; hint: string }[] = [
  { id: 'view', label: 'View', key: 'Escape', hint: 'Preview the design (Esc)' },
  { id: 'edit', label: 'Edit', key: 'e', hint: 'Select, move and style elements (E)' },
  {
    id: 'comment',
    label: 'Comment',
    key: 'c',
    hint: 'Click an element to comment or ask the agent (C)',
  },
];

/** Which modes the current user can enter. */
function useAllowedModes(): Set<EditorMode> {
  const { can, agentAvailable, project } = useEditor();
  const allowed = new Set<EditorMode>(['view']);
  if (canEnterEdit({ can, project })) allowed.add('edit');
  if (can('design:comment') || (can('agent:run') && agentAvailable)) allowed.add('comment');
  return allowed;
}

function ModeSwitch() {
  const mode = useCanvas((s) => s.mode);
  const canvas = useCanvasStoreApi();
  const allowed = useAllowedModes();

  // E / C toggle a mode, Esc in comment mode returns to view (Edit mode handles its own Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const { mode: current, setMode } = canvas.getState();
      const k = e.key.toLowerCase();
      if (k === 'escape' && current === 'comment') setMode('view');
      else if ((k === 'e' || k === 'c') && !e.repeat) {
        const next: EditorMode = k === 'e' ? 'edit' : 'comment';
        if (!allowed.has(next)) return;
        e.preventDefault();
        setMode(current === next ? 'view' : next);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canvas, allowed]);

  return (
    <div role="radiogroup" aria-label="Mode" className="flex rounded-md bg-surface-2 p-0.5 text-xs">
      {MODES.filter((m) => allowed.has(m.id)).map((m) => (
        <button
          key={m.id}
          role="radio"
          aria-checked={mode === m.id}
          title={m.hint}
          onClick={() => canvas.getState().setMode(m.id)}
          className={`rounded px-3 py-1 font-medium transition-colors ${
            mode === m.id ? 'bg-surface text-text shadow-sm' : 'text-muted hover:text-text'
          }`}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

export function EditorShell() {
  const { project, workspace } = useEditor();
  useUndoShortcuts();
  const mode = useCanvas((s) => s.mode);

  return (
    <div className="relative flex h-dvh flex-col">
      <header className="grid h-11 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-border bg-surface px-3 text-sm">
        <div className="flex min-w-0 items-center gap-2.5">
          <Link href={`/w/${workspace.slug}`} aria-label="All projects" title="All projects">
            <Logo compact />
          </Link>
          <span className="truncate font-medium">{project.name}</span>
          <EditLockIndicator />
          <SaveStatus />
        </div>
        <ModeSwitch />
        <div className="flex items-center justify-end gap-1">
          <LintBadge />
          <CollabControls />
          <ExportMenu />
          <span className="ml-1.5 flex">
            <UserButton />
          </span>
        </div>
      </header>
      {/* One row capped at the available height, so panes scroll instead of growing past the viewport. */}
      <div className="grid min-h-0 flex-1 grid-cols-[340px_1fr] grid-rows-[minmax(0,1fr)]">
        <aside className="relative min-h-0 overflow-hidden border-r border-border bg-surface">
          <div className="h-full overflow-auto">
            {mode === 'edit' ? <EditPanel /> : <AgentPane />}
          </div>
          <CommentsPane />
        </aside>
        <section className="min-h-0 min-w-0">
          <CanvasPane />
        </section>
      </div>
      <Notice />
    </div>
  );
}
