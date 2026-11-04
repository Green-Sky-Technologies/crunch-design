'use client';

/**
 * Style editing model for the edit panel (Story 3.3, refactored out of the old inspector): the
 * selected nodes, the breakpoint edits apply at (the frame's own, or an override chosen in the
 * panel), token options per prop, and appliers that write doc-store ops to every selected node.
 * Zero LLM calls. Scrubs preview on the live DOM and commit one op on release.
 */
import {
  frameBreakpoint,
  isLocked,
  propState,
  sharedValue,
  tokensForProp,
  type PropState,
  type TokenOption,
} from '@crunch/canvas';
import {
  BREAKPOINTS,
  STYLE_PROP_NAMES,
  STYLE_PROPS,
  type Breakpoint,
  type DocOp,
  type Frame,
  type Node,
  type StylePropName,
  type StyleProps,
} from '@crunch/doc-model';
import { declarations } from '@crunch/renderer';
import { createContext, useCallback, useContext, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDocStore, useDocStoreApi, useEditor } from '../doc-store';
import { inspectorBreakpoint, useCanvas, useCanvasStoreApi } from './canvas-store';
import { frameIndex } from './context';
import { nodeElement } from './dom';
import type { ApplyMeta } from './style-field';

const BLOCK_PARENT = { display: 'block', direction: 'column' } as const;
const NO_FLAGS = { absolute: false, isBox: false, hidden: false };

export function useEditBreakpoint(frame: Frame | undefined): [Breakpoint, Breakpoint | null] {
  const { designSystem } = useEditor();
  const override = useCanvas((s) => s.editBreakpoint);
  const frameBp = frame ? frameBreakpoint(frame, designSystem.spec) : 'base';
  return [inspectorBreakpoint(override, frame, designSystem.spec), frame ? frameBp : null];
}

/** Breakpoint selector: which breakpoint edits write to (• marks the one the frame renders). */
export function BreakpointTabs({
  bp,
  frameBp,
  frameId,
}: {
  bp: Breakpoint;
  frameBp: Breakpoint | null;
  frameId: string | undefined;
}) {
  const canvas = useCanvasStoreApi();
  const { designSystem } = useEditor();
  const widths = {
    base: 0,
    md: designSystem.spec.breakpoints.md,
    lg: designSystem.spec.breakpoints.lg,
  };
  return (
    <div className="flex items-center gap-1 text-[11px]">
      <span className="text-muted">Breakpoint</span>
      <div role="tablist" aria-label="Breakpoint" className="flex rounded-md bg-surface-2 p-0.5">
        {BREAKPOINTS.map((b) => (
          <button
            key={b}
            role="tab"
            type="button"
            aria-selected={b === bp}
            title={b === 'base' ? 'Base (all widths)' : `≥ ${widths[b]}px`}
            className={`rounded px-1.5 py-0.5 ${b === bp ? 'bg-surface font-medium text-accent shadow-sm' : 'text-muted hover:text-text'}`}
            onClick={() =>
              frameId && canvas.getState().setEditBreakpoint(frameId, b === frameBp ? null : b)
            }
          >
            {b}
            {b === frameBp ? ' •' : ''}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface StyleEditor {
  ids: string[];
  nodes: Node[];
  primary: Node;
  frame: Frame | undefined;
  bp: Breakpoint;
  frameBp: Breakpoint | null;
  /** Edits blocked: role, edit lock, or a locked layer in the selection. */
  readOnly: boolean;
  /** Only the document is read-only (unlocking a layer is still allowed). */
  docReadOnly: boolean;
  locked: boolean;
  tokens(prop: StylePropName): TokenOption[];
  /** Primary node's state for a prop at the breakpoint. */
  state(prop: StylePropName): PropState;
  /** Shared effective value across the selection, or the MIXED sentinel. */
  value(prop: StylePropName): unknown;
  /** Some selected node sets this prop at the breakpoint. */
  isSet(prop: StylePropName): boolean;
  allSet(prop: StylePropName): boolean;
  mixed(prop: StylePropName): boolean;
  /** One prop on every selected node (null unsets). One undo step (or coalesced by key). */
  onApply(prop: StylePropName, value: unknown, meta?: ApplyMeta): boolean;
  /** Several props on every selected node, as one undo step. */
  applyMany(entries: [StylePropName, unknown][], label: string, coalesceKey?: string): boolean;
  /** Unset the given props (where set at this breakpoint), as one undo step. */
  reset(props: readonly StylePropName[], label: string): boolean;
  onPreview(prop: StylePropName, value: unknown): void;
  apply(ops: DocOp[], label: string): boolean;
}

export const MIXED = Symbol('mixed');

const StyleEditorCtx = createContext<StyleEditor | null>(null);
export const StyleEditorProvider = StyleEditorCtx.Provider;
export function useStyle(): StyleEditor {
  const c = useContext(StyleEditorCtx);
  if (!c) throw new Error('useStyle outside StyleEditorProvider');
  return c;
}

/** The style editor for a set of selected node ids. Returns null when none exist. */
export function useStyleEditor(ids: string[], frame: Frame | undefined): StyleEditor | null {
  const { designSystem } = useEditor();
  const readOnly = useDocStore((s) => s.readOnly);
  const nodes = useDocStore(
    useShallow((s) => ids.map((id) => s.doc.nodes[id]).filter((n): n is Node => !!n)),
  );
  const docStore = useDocStoreApi();
  const [bp, frameBp] = useEditBreakpoint(frame);

  const tokenMap = useMemo(() => {
    const m = new Map<StylePropName, TokenOption[]>();
    for (const p of STYLE_PROP_NAMES) m.set(p, tokensForProp(p, designSystem.spec));
    return m;
  }, [designSystem.spec]);

  const idsKey = ids.join(',');
  const onApply = useCallback(
    (prop: StylePropName, value: unknown, meta?: ApplyMeta) => {
      const label = `${value === null ? 'Reset' : 'Set'} ${STYLE_PROPS[prop].label.toLowerCase()}`;
      return docStore.getState().apply(
        idsKey
          .split(',')
          .map((id) => ({ op: 'setStyle' as const, id, breakpoint: bp, prop, value })),
        {
          source: 'inspector',
          label,
          coalesceKey: meta?.coalesceKey ? `${meta.coalesceKey}:${idsKey}` : undefined,
        },
      );
    },
    [docStore, idsKey, bp],
  );

  /**
   * Scrub preview: the value is shown on the live elements (same CSS the renderer emits, as
   * inline !important) and committed as one op on release, so a scrub is always one undo step.
   */
  const previewed = useRef(new Map<HTMLElement, string[]>());
  const onPreview = useCallback(
    (prop: StylePropName, value: unknown) => {
      for (const [el, props] of previewed.current)
        for (const p of props) el.style.removeProperty(p);
      previewed.current.clear();
      if (value === null) return;
      const index = frameIndex(docStore.getState().doc);
      const decls = declarations({ [prop]: value } as StyleProps, BLOCK_PARENT, NO_FLAGS);
      for (const id of idsKey.split(',')) {
        const el = nodeElement(document, index.get(id) ?? '', id);
        if (!el) continue;
        for (const [k, v] of decls) el.style.setProperty(k, v, 'important');
        previewed.current.set(el, [...decls.keys()]);
      }
    },
    [docStore, idsKey],
  );

  if (!nodes.length) return null;
  const primary = nodes[0]!;
  const doc = docStore.getState().doc;
  const locked = nodes.some((n) => isLocked(doc, n.id));
  const styles = nodes.map((n) => n.style);
  const apply = (ops: DocOp[], label: string, coalesceKey?: string) =>
    ops.length > 0 &&
    docStore.getState().apply(ops, {
      source: 'inspector',
      label,
      coalesceKey: coalesceKey ? `${coalesceKey}:${idsKey}` : undefined,
    });
  return {
    ids: nodes.map((n) => n.id),
    nodes,
    primary,
    frame,
    bp,
    frameBp,
    readOnly: readOnly || locked,
    docReadOnly: readOnly,
    locked,
    tokens: (p) => tokenMap.get(p) ?? [],
    state: (p) => propState(primary.style, p, bp),
    value: (p) =>
      nodes.length > 1 && sharedValue(styles, p, bp) === 'mixed'
        ? MIXED
        : propState(primary.style, p, bp).value,
    isSet: (p) => styles.some((st) => propState(st, p, bp).setHere),
    allSet: (p) => styles.every((st) => propState(st, p, bp).setHere),
    mixed: (p) => nodes.length > 1 && sharedValue(styles, p, bp) === 'mixed',
    onApply,
    onPreview,
    applyMany: (entries, label, coalesceKey) =>
      apply(
        nodes.flatMap((n) =>
          entries.map(([prop, value]) => ({
            op: 'setStyle' as const,
            id: n.id,
            breakpoint: bp,
            prop,
            value,
          })),
        ),
        label,
        coalesceKey,
      ),
    reset: (props, label) =>
      apply(
        nodes.flatMap((n) =>
          props
            .filter((p) => propState(n.style, p, bp).setHere)
            .map((prop) => ({
              op: 'setStyle' as const,
              id: n.id,
              breakpoint: bp,
              prop,
              value: null,
            })),
        ),
        label,
      ),
    apply: (ops, label) => apply(ops, label),
  };
}
