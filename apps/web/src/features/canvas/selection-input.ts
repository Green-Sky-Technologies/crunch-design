'use client';

/**
 * Selection input (Story 3.2): click to select a node inside a frame (Shift toggles), hover
 * outlines, and keyboard tree navigation: Esc selects the parent, Enter the first child,
 * Tab/Shift+Tab cycle siblings, Delete removes the selection.
 */
import {
  firstChild,
  isLocked,
  parentOf,
  selectableAt,
  sibling,
  toggleSelection,
  topLevelSelection,
} from '@crunch/canvas';
import { useEffect, type RefObject } from 'react';
import { useDocStoreApi, useEditor, type DocStore } from '../doc-store';
import { useCanvasStoreApi } from './canvas-store';
import { frameIndex } from './context';
import { hitFromEvent } from './dom';
import { startNodeDrag } from './drag';
import { startTextEdit, textTargetFor } from './text-edit';
import { isTypingEvent } from './gesture';

/** Keyboard navigation over the tree. Returns true if the key was handled. */
export function handleTreeKey(store: DocStore, e: KeyboardEvent): boolean {
  const s = store.getState();
  const { doc, selection } = s;
  const ids = selection.nodeIds;
  const first = ids[0];
  const go = (id: string | null) => {
    if (!id) return;
    s.select({ frameId: frameIndex(doc).get(id) ?? selection.frameId, nodeIds: [id] });
  };
  switch (e.key) {
    case 'Escape': {
      if (!first) {
        if (!selection.frameId) return false;
        s.select({ frameId: null, nodeIds: [] });
        return true;
      }
      const parent = parentOf(doc, first);
      if (parent) go(parent);
      else s.select({ nodeIds: [] }); // at the frame root: the frame becomes selected
      return true;
    }
    case 'Enter': {
      if (first) go(firstChild(doc, first));
      else {
        const frame = doc.frames.find((f) => f.id === selection.frameId);
        if (!frame) return false;
        go(frame.rootNodeId);
      }
      return true;
    }
    case 'Tab': {
      if (!first) return false;
      go(sibling(doc, first, e.shiftKey ? -1 : 1));
      return true;
    }
    case 'Delete':
    case 'Backspace': {
      const removable = topLevelSelection(doc, ids).filter((id) => !isLocked(doc, id));
      if (!removable.length || s.readOnly) return false;
      const parent = parentOf(doc, removable[0]!);
      const ok = s.apply(
        removable.map((id) => ({ op: 'removeNode' as const, id })),
        { source: 'canvas', label: removable.length > 1 ? 'Delete layers' : 'Delete layer' },
      );
      if (ok) s.select({ nodeIds: parent ? [parent] : [] });
      return true;
    }
  }
  return false;
}

export function useSelectionInput(viewportRef: RefObject<HTMLDivElement | null>) {
  const store = useDocStoreApi();
  const canvas = useCanvasStoreApi();
  const ds = useEditor().designSystem.spec;

  useEffect(() => {
    const el = viewportRef.current!;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.defaultPrevented) return;
      const hit = hitFromEvent(e);
      if (!hit) return;
      const s = store.getState();
      const id = selectableAt(s.doc, hit.nodeId);
      if (!id) return;
      const additive = e.shiftKey;
      const prev = s.selection.frameId === hit.frameId ? s.selection.nodeIds : [];
      // Pressing an already-selected node keeps a multi-selection intact (so it can be dragged).
      if (additive || !prev.includes(id))
        s.select({ frameId: hit.frameId, nodeIds: toggleSelection(prev, id, additive) });
      if (store.getState().selection.nodeIds.includes(id))
        startNodeDrag({ docStore: store, canvas, viewport: el, ds }, e, { ...hit, nodeId: id });
    };
    const onMove = (e: PointerEvent) => {
      const c = canvas.getState();
      if (e.buttons || c.gesture) return;
      const hit = hitFromEvent(e);
      if (!hit) return c.setHover(null);
      const id = selectableAt(store.getState().doc, hit.nodeId);
      c.setHover(id ? { frameId: hit.frameId, nodeId: id } : null);
    };
    const onLeave = () => canvas.getState().setHover(null);
    // Designs are inert on the canvas: links don't navigate and buttons don't submit.
    const onClick = (e: MouseEvent) => {
      if (hitFromEvent(e)) e.preventDefault();
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTypingEvent(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (canvas.getState().gesture) return;
      // Only when focus is on the page or the canvas, not another pane's control.
      const active = document.activeElement;
      if (active && active !== document.body && !el.contains(active)) return;
      // A focused canvas control (layers row, toolbar button) keeps Enter/Space/Tab for itself.
      if (active?.matches('button, select, a[href]') && ['Enter', 'Tab', ' '].includes(e.key))
        return;
      // Enter on a single selected text node edits it in place.
      const sel = store.getState().selection.nodeIds;
      if (e.key === 'Enter' && sel.length === 1) {
        const doc = store.getState().doc;
        const frameId = frameIndex(doc).get(sel[0]!);
        const t = frameId && textTargetFor(doc, ds, frameId, sel[0]!);
        if (t && startTextEdit({ docStore: store, canvas, viewport: el }, t)) {
          e.preventDefault();
          return;
        }
      }
      if (handleTreeKey(store, e)) e.preventDefault();
    };
    const onDblClick = (e: MouseEvent) => {
      const hit = hitFromEvent(e);
      if (!hit || canvas.getState().gesture) return;
      const doc = store.getState().doc;
      const id = selectableAt(doc, hit.nodeId);
      if (!id) return;
      const t = textTargetFor(
        doc,
        ds,
        hit.frameId,
        id,
        id === hit.nodeId ? hit.el.dataset.cdPart : undefined,
      );
      if (!t) return;
      store.getState().select({ frameId: hit.frameId, nodeIds: [id] });
      if (startTextEdit({ docStore: store, canvas, viewport: el }, t)) e.preventDefault();
    };
    el.addEventListener('pointerdown', onDown);
    if (
      typeof performance !== 'undefined' &&
      !performance.getEntriesByName('cd:canvas-interactive').length
    )
      performance.mark('cd:canvas-interactive');
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('click', onClick, true);
    el.addEventListener('dblclick', onDblClick);
    window.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('click', onClick, true);
      el.removeEventListener('dblclick', onDblClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [viewportRef, store, canvas, ds]);
}
