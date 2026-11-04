'use client';

/**
 * Layer tree (Story 3.2, edit panel): every frame's node tree, indented and collapsible. Rows show
 * an icon, a semantic name (Row / Column / Grid, else the layer name or its tag: "Header",
 * "Link", "Heading"), a quoted preview for text, and the HTML tag. Click selects (Shift toggles),
 * hovering highlights the node on the canvas, the eye hides, and dragging a row reorders or
 * reparents it (one moveNode op). Ancestors of the selection expand automatically.
 */
import {
  ancestors,
  canDropInto,
  isContainer,
  isLocked,
  layerName,
  layerRows,
  moveOps,
  nodeTag,
  textPreview,
  toggleSelection,
  type LayerRow,
} from '@crunch/canvas';
import type { DesignDoc, Node } from '@crunch/doc-model';
import { memo, useCallback, useState } from 'react';
import { useDocStore, useDocStoreApi, useEditor } from '../doc-store';
import { useCanvas, useCanvasStoreApi } from './canvas-store';

const ICON: Record<string, string> = { box: '▢', text: 'T', image: '▣', svg: '◇', instance: '◈' };
const LAYOUT_ICON: Record<string, string> = { Row: '⇥', Column: '⇩', Grid: '⊞' };

type DropAt = { id: string; where: 'before' | 'after' | 'inside' };

/** Where a row drop lands: before/after the row, or inside it (containers, middle half). */
function dropPlacement(
  doc: DesignDoc,
  dragId: string,
  at: DropAt,
): { parentId: string; beforeId: string | null } | null {
  const target = doc.nodes[at.id];
  if (!target) return null;
  if (at.where === 'inside') return { parentId: at.id, beforeId: null };
  if (!target.parentId) return null;
  const sibs = doc.nodes[target.parentId]!.children.filter((c) => c !== dragId);
  const i = sibs.indexOf(at.id);
  return {
    parentId: target.parentId,
    beforeId: at.where === 'before' ? at.id : (sibs[i + 1] ?? null),
  };
}

export function LayerTree() {
  const doc = useDocStore((s) => s.doc);
  const selection = useDocStore((s) => s.selection);
  const readOnly = useDocStore((s) => s.readOnly);
  const hoverId = useCanvas((s) => s.hover?.nodeId);
  const docStore = useDocStoreApi();
  const { designSystem } = useEditor();

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

  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropAt | null>(null);
  const onDrop = useCallback(() => {
    const s = docStore.getState();
    const place = drag && drop ? dropPlacement(s.doc, drag, drop) : null;
    setDrag(null);
    setDrop(null);
    if (!drag || !place || isLocked(s.doc, place.parentId)) return;
    const ops = moveOps(s.doc, [drag], place.parentId, place.beforeId);
    if (ops.length && s.apply(ops, { source: 'canvas', label: 'Move layer' }))
      s.select({ nodeIds: [drag] });
  }, [docStore, drag, drop]);
  const dnd = {
    drag,
    drop,
    start: setDrag,
    over: (at: DropAt | null) => {
      const s = docStore.getState();
      const place = drag && at ? dropPlacement(s.doc, drag, at) : null;
      const ok =
        !!place && canDropInto(s.doc, [drag!], place.parentId) && !isLocked(s.doc, place.parentId);
      setDrop((d) =>
        ok ? (d?.id === at!.id && d.where === at!.where ? d : at) : d === null ? d : null,
      );
      return ok;
    },
    end: onDrop,
  };

  return (
    <nav aria-label="Layers" className="py-1 text-xs">
      {doc.frames.map((f) => {
        const frameOpen = !expanded.has(`frame-closed:${f.id}`);
        return (
          <div key={f.id} role="group" aria-label={f.name}>
            <div
              className={`flex h-7 items-center gap-1 px-2 font-medium ${
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
              <span className="w-4 text-center text-muted" aria-hidden>
                #
              </span>
              <button
                type="button"
                className="flex-1 truncate text-left"
                onClick={() => docStore.getState().select({ frameId: f.id, nodeIds: [] })}
              >
                {f.name}
              </button>
              <span className="font-mono text-[10px] text-muted">{f.width}</span>
            </div>
            {frameOpen && (
              <ul role="tree" aria-label={`${f.name} layers`}>
                {layerRows(doc, f.rootNodeId, expanded).map((r) => {
                  const n = doc.nodes[r.id]!;
                  return (
                    <LayerItem
                      key={r.id}
                      row={r}
                      node={n}
                      componentName={
                        n.type === 'instance'
                          ? designSystem.spec.components[n.componentRef.componentId]?.name
                          : undefined
                      }
                      frameId={f.id}
                      selected={selection.nodeIds.includes(r.id)}
                      hovered={hoverId === r.id}
                      readOnly={readOnly}
                      lockedTree={isLocked(doc, r.id)}
                      dropHere={drop?.id === r.id ? drop.where : null}
                      dnd={dnd}
                      onToggle={toggle}
                    />
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}

interface Dnd {
  drag: string | null;
  start(id: string | null): void;
  over(at: DropAt | null): boolean;
  end(): void;
}

interface LayerItemProps {
  row: LayerRow;
  node: Node;
  componentName?: string;
  frameId: string;
  selected: boolean;
  hovered: boolean;
  readOnly: boolean;
  /** The row or an ancestor is locked: no visibility toggle, no dragging. */
  lockedTree: boolean;
  dropHere: DropAt['where'] | null;
  dnd: Dnd;
  onToggle(id: string): void;
}

/** One layer row. Memoized on its row facts, so a doc edit only re-renders the rows it changes. */
const LayerItem = memo(
  function LayerItem({
    row: r,
    node,
    componentName,
    frameId,
    selected,
    hovered,
    readOnly,
    lockedTree,
    dropHere,
    dnd,
    onToggle,
  }: LayerItemProps) {
    const docStore = useDocStoreApi();
    const canvas = useCanvasStoreApi();
    const name = layerName(node, componentName);
    // Text shows a quoted preview; a laid-out box shows its own name after "Row"/"Column".
    const preview = textPreview(node, 28) || (node.name && node.name !== name ? node.name : '');
    const tag = nodeTag(node);
    const draggable = !readOnly && !lockedTree && r.depth > 0;
    return (
      <li
        role="treeitem"
        aria-selected={selected}
        aria-expanded={r.hasChildren ? r.expanded : undefined}
        data-layer={r.id}
        draggable={draggable}
        className={`group relative flex h-7 items-center gap-1 pr-2 ${
          selected ? 'bg-accent/15 text-accent' : hovered ? 'bg-surface-2' : ''
        } ${r.hidden ? 'opacity-50' : ''} ${dropHere === 'inside' ? 'ring-1 ring-accent ring-inset' : ''}`}
        style={{ paddingLeft: 8 + r.depth * 12 }}
        onPointerEnter={() => canvas.getState().setHover({ frameId, nodeId: r.id })}
        onPointerLeave={() => canvas.getState().setHover(null)}
        onDragStart={(e) => {
          e.dataTransfer?.setData('text/plain', r.id);
          dnd.start(r.id);
        }}
        onDragOver={(e) => {
          if (!dnd.drag || dnd.drag === r.id) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const y = (e.clientY - rect.top) / (rect.height || 1);
          const where: DropAt['where'] =
            isContainer(node) && y > 0.25 && y < 0.75 ? 'inside' : y < 0.5 ? 'before' : 'after';
          if (dnd.over({ id: r.id, where })) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          dnd.end();
        }}
        onDragEnd={() => dnd.start(null)}
      >
        {dropHere && dropHere !== 'inside' && (
          <span
            aria-hidden
            className="pointer-events-none absolute right-0 h-0.5 bg-accent"
            style={{ left: 8 + r.depth * 12, [dropHere === 'before' ? 'top' : 'bottom']: 0 }}
          />
        )}
        <button
          type="button"
          tabIndex={-1}
          aria-hidden={!r.hasChildren}
          className="w-4 shrink-0 text-muted"
          style={{ visibility: r.hasChildren ? 'visible' : 'hidden' }}
          onClick={() => onToggle(r.id)}
        >
          {r.expanded ? '▾' : '▸'}
        </button>
        <span className="w-4 shrink-0 text-center text-muted" aria-hidden>
          {LAYOUT_ICON[name] ?? ICON[r.type]}
        </span>
        <button
          type="button"
          aria-label={preview ? `${name} ${preview}` : name}
          className="flex min-w-0 flex-1 items-baseline gap-1 truncate text-left"
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
          <span className="shrink-0">{name}</span>
          {preview && <span className="truncate text-muted">{preview}</span>}
          {r.locked ? <span aria-label="locked">🔒</span> : null}
        </button>
        {!readOnly && !lockedTree && r.depth > 0 && (
          <button
            type="button"
            aria-label={r.hidden ? `Show ${name}` : `Hide ${name}`}
            className={`shrink-0 text-muted ${r.hidden ? '' : 'invisible group-hover:visible'}`}
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
        <span className="shrink-0 font-mono text-[10px] text-muted">{tag}</span>
      </li>
    );
  },
  (a, b) =>
    a.node === b.node &&
    a.row.depth === b.row.depth &&
    a.row.hasChildren === b.row.hasChildren &&
    a.row.expanded === b.row.expanded &&
    a.componentName === b.componentName &&
    a.frameId === b.frameId &&
    a.selected === b.selected &&
    a.hovered === b.hovered &&
    a.readOnly === b.readOnly &&
    a.lockedTree === b.lockedTree &&
    a.dropHere === b.dropHere &&
    a.dnd.drag === b.dnd.drag &&
    a.onToggle === b.onToggle,
);
