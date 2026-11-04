'use client';

/**
 * Layers panel (Story 3.2): frames and their node trees, mirroring the document. Click selects
 * (Shift toggles), hovering highlights on the canvas, the caret expands, the eye hides.
 * Ancestors of the selection expand automatically.
 */
import { ancestors, isLocked, layerRows, toggleSelection, type LayerRow } from '@crunch/canvas';
import { memo, useCallback, useState } from 'react';
import { useDocStore, useDocStoreApi } from '../doc-store';
import { useCanvas, useCanvasStoreApi } from './canvas-store';

const ICON: Record<string, string> = { box: '▢', text: 'T', image: '▣', svg: '◇', instance: '◈' };

export function LayersPanel() {
  const doc = useDocStore((s) => s.doc);
  const selection = useDocStore((s) => s.selection);
  const readOnly = useDocStore((s) => s.readOnly);
  const open = useCanvas((s) => s.layersOpen);
  const hoverId = useCanvas((s) => s.hover?.nodeId);
  const docStore = useDocStoreApi();

  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(doc.frames.map((f) => f.rootNodeId)),
  );
  const toggle = useCallback(
    (id: string) =>
      setExpanded((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    [],
  );

  // Reveal the selection: expand its ancestors when it changes (state adjusted during render).
  const [revealed, setRevealed] = useState(selection.nodeIds);
  if (revealed !== selection.nodeIds) {
    setRevealed(selection.nodeIds);
    const need = selection.nodeIds
      .flatMap((id) => ancestors(doc, id))
      .filter((a) => !expanded.has(a));
    if (need.length) setExpanded(new Set([...expanded, ...need]));
  }

  if (!open) return null;

  return (
    <nav
      aria-label="Layers"
      className="card shadow-sm"
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        left: 12,
        top: 12,
        bottom: 60,
        width: 232,
        overflow: 'auto',
        fontSize: 12,
        padding: '4px 0',
      }}
    >
      {doc.frames.map((f) => {
        const frameOpen = !expanded.has(`frame-closed:${f.id}`);
        return (
          <div key={f.id} role="group" aria-label={f.name}>
            <div
              className={`flex items-center gap-1 px-2 py-1 font-medium ${
                selection.frameId === f.id && !selection.nodeIds.length
                  ? 'bg-accent/10 text-accent'
                  : ''
              }`}
            >
              <button
                type="button"
                aria-label={frameOpen ? `Collapse ${f.name}` : `Expand ${f.name}`}
                className="w-4 text-muted"
                onClick={() =>
                  setExpanded((s) => {
                    const n = new Set(s);
                    if (frameOpen) n.add(`frame-closed:${f.id}`);
                    else n.delete(`frame-closed:${f.id}`);
                    return n;
                  })
                }
              >
                {frameOpen ? '▾' : '▸'}
              </button>
              <button
                type="button"
                className="flex-1 truncate text-left"
                onClick={() => docStore.getState().select({ frameId: f.id, nodeIds: [] })}
              >
                {f.name}
              </button>
            </div>
            {frameOpen && (
              <ul role="tree" aria-label={`${f.name} layers`}>
                {layerRows(doc, f.rootNodeId, expanded).map((r) => (
                  <LayerItem
                    key={r.id}
                    row={r}
                    frameId={f.id}
                    selected={selection.nodeIds.includes(r.id)}
                    hovered={hoverId === r.id}
                    readOnly={readOnly}
                    lockedTree={isLocked(doc, r.id)}
                    onToggle={toggle}
                  />
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}

interface LayerItemProps {
  row: LayerRow;
  frameId: string;
  selected: boolean;
  hovered: boolean;
  readOnly: boolean;
  /** The row or an ancestor is locked: no visibility toggle. */
  lockedTree: boolean;
  onToggle(id: string): void;
}

const sameRow = (a: LayerRow, b: LayerRow) =>
  a.id === b.id &&
  a.depth === b.depth &&
  a.label === b.label &&
  a.type === b.type &&
  a.hasChildren === b.hasChildren &&
  a.expanded === b.expanded &&
  a.hidden === b.hidden &&
  a.locked === b.locked;

/** One layer row. Memoized on its row facts, so a doc edit only re-renders the rows it changes. */
const LayerItem = memo(
  function LayerItem({
    row: r,
    frameId,
    selected,
    hovered,
    readOnly,
    lockedTree,
    onToggle,
  }: LayerItemProps) {
    const docStore = useDocStoreApi();
    const canvas = useCanvasStoreApi();
    return (
      <li
        role="treeitem"
        aria-selected={selected}
        aria-expanded={r.hasChildren ? r.expanded : undefined}
        data-layer={r.id}
        className={`group flex items-center gap-1 pr-2 ${
          selected ? 'bg-accent/15 text-accent' : hovered ? 'bg-surface-2' : ''
        } ${r.hidden ? 'opacity-50' : ''}`}
        style={{ paddingLeft: 8 + r.depth * 12, height: 24 }}
        onPointerEnter={() => canvas.getState().setHover({ frameId, nodeId: r.id })}
        onPointerLeave={() => canvas.getState().setHover(null)}
      >
        <button
          type="button"
          tabIndex={-1}
          aria-hidden={!r.hasChildren}
          className="w-4 text-muted"
          style={{ visibility: r.hasChildren ? 'visible' : 'hidden' }}
          onClick={() => onToggle(r.id)}
        >
          {r.expanded ? '▾' : '▸'}
        </button>
        <span className="w-3 text-center text-muted" aria-hidden>
          {ICON[r.type]}
        </span>
        <button
          type="button"
          className="flex-1 truncate text-left"
          onClick={(e) => {
            const s = docStore.getState();
            s.select({
              frameId,
              nodeIds: toggleSelection(
                s.selection.frameId === frameId ? s.selection.nodeIds : [],
                r.id,
                e.shiftKey,
              ),
            });
          }}
        >
          {r.label}
          {r.locked ? ' 🔒' : ''}
        </button>
        {!readOnly && !lockedTree && r.depth > 0 && (
          <button
            type="button"
            aria-label={r.hidden ? `Show ${r.label}` : `Hide ${r.label}`}
            className={`text-muted ${r.hidden ? '' : 'invisible group-hover:visible'}`}
            onClick={() =>
              docStore
                .getState()
                .apply(
                  [{ op: 'setNodeMeta', id: r.id, patch: { hidden: r.hidden ? null : true } }],
                  { source: 'canvas', label: r.hidden ? 'Show layer' : 'Hide layer' },
                )
            }
          >
            {r.hidden ? '◌' : '●'}
          </button>
        )}
      </li>
    );
  },
  (a, b) =>
    sameRow(a.row, b.row) &&
    a.frameId === b.frameId &&
    a.selected === b.selected &&
    a.hovered === b.hovered &&
    a.readOnly === b.readOnly &&
    a.lockedTree === b.lockedTree &&
    a.onToggle === b.onToggle,
);
