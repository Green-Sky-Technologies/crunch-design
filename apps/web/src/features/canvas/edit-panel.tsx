'use client';

/**
 * Edit panel (left pane in edit mode): header with Discard / Save, the tool row, the layer tree
 * (resizable), and tabs for the selection: Simple, Pro, Code and Tweaks. Reads everything from
 * useEditor() / useDocStore() and the canvas store; the shell renders it with no props.
 *
 * Edit session: entering edit mode starts a session (canvas-store). Edits apply live and
 * autosave as always; Discard undoes everything done since the session started and returns to
 * view mode (the steps stay on the redo stack); Save keeps them and returns to view mode.
 */
import type { Tool } from '@crunch/canvas';
import { safeImageSrc, type Frame } from '@crunch/doc-model';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useDocStore, useDocStoreApi, useEditor } from '../doc-store';
import {
  canEnterEdit,
  discardEditSession,
  saveEditSession,
  useCanvas,
  useCanvasStoreApi,
} from './canvas-store';
import { CodeTab } from './code-tab';
import { frameIndex } from './context';
import { FrameFields } from './frame-fields';
import { startGesture } from './gesture';
import { LayerTree } from './layer-tree';
import { useEditLock } from './lock';
import { ProTab, SimpleTab } from './properties';
import { StyleEditorProvider, useStyleEditor } from './style-editing';
import { TweaksTab } from './tweaks-tab';

type Tab = 'simple' | 'pro' | 'code' | 'tweaks';
const TABS: [Tab, string][] = [
  ['simple', 'Simple'],
  ['pro', 'Pro'],
  ['code', 'Code'],
  ['tweaks', 'Tweaks'],
];

const ic = (d: ReactNode) => (
  <svg
    aria-hidden
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {d}
  </svg>
);

const TOOLS: { tool: Tool; label: string; key: string; icon: ReactNode }[] = [
  { tool: 'select', label: 'Select', key: 'V', icon: ic(<path d="M3.5 2.5l9 5-4 1-2 4z" />) },
  { tool: 'text', label: 'Text', key: 'T', icon: ic(<path d="M3.5 3.5h9M8 3.5v9" />) },
  {
    tool: 'box',
    label: 'Frame',
    key: 'F',
    icon: ic(<path d="M5 2v12M11 2v12M2 5h12M2 11h12" />),
  },
  {
    tool: 'rect',
    label: 'Rectangle',
    key: 'R',
    icon: ic(<rect x="2.5" y="3.5" width="11" height="9" rx="1" />),
  },
  { tool: 'ellipse', label: 'Ellipse', key: 'O', icon: ic(<circle cx="8" cy="8" r="5.5" />) },
  { tool: 'line', label: 'Line', key: 'L', icon: ic(<path d="M3 13L13 3" />) },
  { tool: 'arrow', label: 'Arrow', key: 'A', icon: ic(<path d="M3 13L13 3M7 3h6v6" />) },
  {
    tool: 'pencil',
    label: 'Pencil',
    key: 'P',
    icon: ic(<path d="M10.5 2.5l3 3-8 8H2.5v-3z" />),
  },
];

function ToolButton({
  label,
  title,
  pressed,
  onClick,
  disabled,
  children,
  ...rest
}: {
  label: string;
  title?: string;
  pressed?: boolean;
  onClick(): void;
  disabled?: boolean;
  children: ReactNode;
} & React.AriaAttributes) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      disabled={disabled}
      className={`flex h-7 w-7 items-center justify-center rounded-md ${
        pressed ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-surface-2 hover:text-text'
      } disabled:opacity-40`}
      onClick={onClick}
      {...rest}
    >
      {children}
    </button>
  );
}

function ImageTool({ disabled }: { disabled: boolean }) {
  const canvas = useCanvasStoreApi();
  const active = useCanvas((s) => s.tool === 'image');
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [error, setError] = useState(false);
  const place = () => {
    const src = url.trim();
    if (!safeImageSrc.safeParse(src).success) return setError(true);
    setOpen(false);
    setError(false);
    canvas.getState().setTool('image', { src });
  };
  return (
    <div className="relative">
      <ToolButton
        label="Image"
        pressed={active || open}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {ic(
          <>
            <rect x="2.5" y="3" width="11" height="10" rx="1" />
            <path d="M3 11l3-3 3 3 2-2 2.5 2.5" />
            <circle cx="10.5" cy="6" r="1" />
          </>,
        )}
      </ToolButton>
      {open && (
        <div
          role="dialog"
          aria-label="Insert image"
          className="card absolute top-full left-0 z-30 mt-1 w-64 space-y-2 p-2 shadow-lg"
        >
          <input
            autoFocus
            aria-label="Image URL"
            aria-invalid={error}
            placeholder="https://…"
            className="input py-1 text-xs"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') place();
              if (e.key === 'Escape') setOpen(false);
            }}
          />
          {error && <p className="text-[11px] text-danger">Use an https:// image URL.</p>}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted">Then click the canvas to place it.</span>
            <button type="button" className="btn-primary px-2 py-1 text-xs" onClick={place}>
              Place
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ComponentsMenu({ disabled }: { disabled: boolean }) {
  const { designSystem } = useEditor();
  const canvas = useCanvasStoreApi();
  const active = useCanvas((s) => s.tool === 'component');
  const [open, setOpen] = useState(false);
  const components = Object.values(designSystem.spec.components);
  if (!components.length) return null;
  return (
    <div className="relative">
      <ToolButton
        label="Insert component"
        pressed={active || open}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {ic(
          <path d="M8 2l2.5 2.5L8 7 5.5 4.5zM8 9l2.5 2.5L8 14l-2.5-2.5zM2 8l2.5-2.5L7 8 4.5 10.5zM9 8l2.5-2.5L14 8l-2.5 2.5z" />,
        )}
      </ToolButton>
      {open && (
        <div
          role="menu"
          aria-label="Components"
          className="card absolute top-full left-0 z-30 mt-1 max-h-72 w-56 overflow-auto py-1 shadow-lg"
        >
          {components.map((c) => (
            <button
              key={c.id}
              role="menuitem"
              type="button"
              title={c.description}
              className="block w-full px-3 py-1.5 text-left text-xs hover:bg-surface-2"
              onClick={() => {
                setOpen(false);
                canvas.getState().setTool('component', { componentId: c.id });
              }}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolRow({ disabled }: { disabled: boolean }) {
  const canvas = useCanvasStoreApi();
  const tool = useCanvas((s) => s.tool);
  const canUndo = useDocStore((s) => s.canUndo());
  const canRedo = useDocStore((s) => s.canRedo());
  const undo = useDocStore((s) => s.undo);
  const redo = useDocStore((s) => s.redo);
  return (
    <div
      role="toolbar"
      aria-label="Tools"
      className="flex items-center gap-0.5 border-b border-border px-2 py-1"
    >
      {TOOLS.map((t) => (
        <ToolButton
          key={t.tool}
          label={`${t.label} (${t.key})`}
          pressed={tool === t.tool}
          disabled={disabled && t.tool !== 'select'}
          onClick={() => canvas.getState().setTool(t.tool)}
        >
          {t.icon}
        </ToolButton>
      ))}
      <ImageTool disabled={disabled} />
      <ComponentsMenu disabled={disabled} />
      <div className="ml-auto flex items-center gap-0.5">
        <ToolButton label="Undo" title="Undo (⌘Z)" disabled={!canUndo} onClick={undo}>
          {ic(<path d="M5 6.5H10a3 3 0 010 6H7M5 6.5L7.5 4M5 6.5L7.5 9" />)}
        </ToolButton>
        <ToolButton label="Redo" title="Redo (⇧⌘Z)" disabled={!canRedo} onClick={redo}>
          {ic(<path d="M11 6.5H6a3 3 0 000 6h3M11 6.5L8.5 4M11 6.5L8.5 9" />)}
        </ToolButton>
      </div>
    </div>
  );
}

/** Height of the layer tree, dragged with the divider below it. */
function useTreeHeight(): [number, (e: React.PointerEvent) => void, (d: number) => void] {
  const [h, setH] = useState(240);
  const clamp = (n: number) => Math.round(Math.min(Math.max(n, 72), 720));
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = h;
    startGesture(e, { onMove: (_e, _dx, dy) => setH(clamp(start + dy)) }, 0);
  };
  return [h, onDown, (d) => setH((x) => clamp(x + d))];
}

function NodeProperties({
  ids,
  frame,
  tab,
}: {
  ids: string[];
  frame: Frame | undefined;
  tab: 'simple' | 'pro';
}) {
  const editor = useStyleEditor(ids, frame);
  if (!editor) return null;
  return (
    <StyleEditorProvider value={editor}>
      {tab === 'simple' ? <SimpleTab /> : <ProTab />}
    </StyleEditorProvider>
  );
}

function SelectionHint() {
  return (
    <p className="p-4 text-xs text-muted">
      Select a layer on the canvas or in the tree to edit it, or pick a tool to add one.
    </p>
  );
}

export function EditPanel() {
  const info = useEditor();
  const allowed = canEnterEdit(info);
  const docStore = useDocStoreApi();
  const canvas = useCanvasStoreApi();
  const mode = useCanvas((s) => s.mode);
  const readOnly = useDocStore((s) => s.readOnly);
  const reason = useDocStore((s) => s.readOnlyReason);
  const selection = useDocStore((s) => s.selection);
  const doc = useDocStore((s) => s.doc);
  const { refresh, state: lockState } = useEditLock();
  const refreshRef = useRef(refresh);
  const [tab, setTab] = useState<Tab>('simple');
  const [treeH, onDivider, nudgeTree] = useTreeHeight();

  // Entering edit mode re-checks the soft lock: takes it if free, else shows who holds it.
  useEffect(() => {
    if (allowed && mode === 'edit') void refreshRef.current();
  }, [allowed, mode]);
  // Viewers and archived projects can't be in edit mode.
  useEffect(() => {
    if (!allowed && mode === 'edit') canvas.getState().setMode('view');
  }, [allowed, mode, canvas]);

  if (!allowed) {
    return (
      <div data-testid="edit-panel" className="p-4 text-sm text-muted">
        {info.project.archived
          ? 'This project is archived. Restore it from the projects page to edit it.'
          : 'You have view access to this project, so it can’t be edited.'}
      </div>
    );
  }

  const ids = selection.nodeIds.filter((id) => doc.nodes[id]);
  const frameId = ids.length
    ? (frameIndex(doc).get(ids[0]!) ?? selection.frameId)
    : selection.frameId;
  const frame = doc.frames.find((f) => f.id === frameId);
  const lockedOut = readOnly && reason === 'locked';

  let body: ReactNode;
  if (tab === 'tweaks') body = <TweaksTab />;
  else if (tab === 'code')
    body = <CodeTab nodeId={ids.length === 1 ? ids[0] : undefined} frameId={frame?.id} />;
  else if (ids.length)
    body = <NodeProperties key={ids.join(',')} ids={ids} frame={frame} tab={tab} />;
  else if (frame) body = <FrameFields key={frame.id} frame={frame} />;
  else body = <SelectionHint />;

  return (
    <div
      data-testid="edit-panel"
      data-cd-keyscope=""
      className="flex h-full min-h-0 flex-col bg-surface text-text"
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <h2 className="text-sm font-semibold">Edit</h2>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            className="btn-ghost px-2.5 py-1 text-xs"
            title="Undo everything since you started editing (Redo brings it back)"
            onClick={() => discardEditSession(docStore, canvas)}
          >
            Discard
          </button>
          <button
            type="button"
            className="btn-primary px-3 py-1 text-xs"
            title="Keep your changes and stop editing (Esc)"
            onClick={() => void saveEditSession(docStore, canvas)}
          >
            Save
          </button>
        </div>
      </header>
      {lockedOut && (
        <div
          role="status"
          className="space-y-1 border-b border-border bg-surface-2 px-3 py-2 text-xs"
        >
          <p className="text-muted">
            Editing is locked: {lockState?.lock?.holder.name ?? 'a teammate'} has control. Your
            changes can’t be saved until they hand over; you can request control from the top bar.
          </p>
        </div>
      )}
      <ToolRow disabled={readOnly} />
      <div className="shrink-0 overflow-auto" style={{ height: treeH }}>
        <LayerTree />
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize layers"
        aria-valuenow={treeH}
        tabIndex={0}
        className="group flex h-2 shrink-0 cursor-row-resize items-center border-y border-border bg-surface-2 hover:bg-accent/10"
        onPointerDown={onDivider}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') nudgeTree(e.shiftKey ? -40 : -10);
          if (e.key === 'ArrowDown') nudgeTree(e.shiftKey ? 40 : 10);
        }}
      >
        <span className="mx-auto h-0.5 w-8 rounded bg-border group-hover:bg-accent" />
      </div>
      <div
        role="tablist"
        aria-label="Edit panel"
        className="flex shrink-0 gap-1 border-b border-border px-2 pt-1"
      >
        {TABS.map(([t, label]) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            className={`-mb-px border-b-2 px-2 py-1.5 text-xs ${
              tab === t
                ? 'border-accent font-medium text-text'
                : 'border-transparent text-muted hover:text-text'
            }`}
            onClick={() => setTab(t)}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-auto">
        {body}
      </div>
    </div>
  );
}
