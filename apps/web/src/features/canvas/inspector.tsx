'use client';

/**
 * Inspector (Story 3.3): every allowlisted StyleProp, grouped, each accepting a literal or a
 * design-system token, edited at a chosen breakpoint with provenance (set here / inherited).
 * All edits are doc-store ops (zero LLM calls). Applies to every selected node.
 */
import {
  frameBreakpoint,
  inspectorGroups,
  nodeLabel,
  propState,
  sharedValue,
  tokensForProp,
  type TokenOption,
} from '@crunch/canvas';
import {
  BREAKPOINTS,
  STYLE_PROPS,
  type Breakpoint,
  type DocOp,
  type Frame,
  type Node,
  type StylePropName,
} from '@crunch/doc-model';
import { useCallback, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDocStore, useDocStoreApi, useEditor } from '../doc-store';
import { useCanvas, useCanvasStoreApi } from './canvas-store';
import { frameIndex } from './context';
import { StyleField, type ApplyMeta } from './style-field';

const GROUPS = inspectorGroups();
const DEFAULT_OPEN = new Set(['layout', 'size', 'spacing', 'typography', 'fill', 'border']);

function Section({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle(): void;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-border py-1">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center justify-between px-3 py-1 text-xs font-semibold"
        onClick={onToggle}
      >
        {title}
        <span className="text-muted">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="pb-1">{children}</div>}
    </section>
  );
}

function useEditBreakpoint(frame: Frame | undefined): [Breakpoint, Breakpoint | null] {
  const { designSystem } = useEditor();
  const override = useCanvas((s) => s.editBreakpoint);
  const frameBp = frame ? frameBreakpoint(frame, designSystem.spec) : 'base';
  return [override ?? frameBp, frame ? frameBp : null];
}

function BreakpointTabs({ bp, frameBp }: { bp: Breakpoint; frameBp: Breakpoint | null }) {
  const canvas = useCanvasStoreApi();
  const { designSystem } = useEditor();
  const widths = {
    base: 0,
    md: designSystem.spec.breakpoints.md,
    lg: designSystem.spec.breakpoints.lg,
  };
  return (
    <div className="flex items-center gap-1 px-3 pb-2 text-xs">
      <span className="text-muted">Edit at</span>
      <div role="tablist" aria-label="Breakpoint" className="flex rounded border border-border">
        {BREAKPOINTS.map((b) => (
          <button
            key={b}
            role="tab"
            type="button"
            aria-selected={b === bp}
            title={b === 'base' ? 'Base (all widths)' : `≥ ${widths[b]}px`}
            className={`px-2 py-0.5 ${b === bp ? 'bg-accent text-accent-ink' : 'hover:bg-surface-2'}`}
            onClick={() => canvas.getState().setEditBreakpoint(b === frameBp ? null : b)}
          >
            {b}
            {b === frameBp ? ' •' : ''}
          </button>
        ))}
      </div>
    </div>
  );
}

function NodeMeta({ nodes, readOnly }: { nodes: Node[]; readOnly: boolean }) {
  const docStore = useDocStoreApi();
  const n = nodes[0]!;
  const [draft, setDraft] = useState<string | null>(null);
  const meta = (patch: Extract<DocOp, { op: 'setNodeMeta' }>['patch'], label: string) =>
    docStore.getState().apply(
      nodes.map((x) => ({ op: 'setNodeMeta' as const, id: x.id, patch })),
      { source: 'inspector', label },
    );
  return (
    <div className="space-y-1 px-3 pb-2 text-xs">
      {nodes.length === 1 && (
        <input
          aria-label="Layer name"
          disabled={readOnly}
          className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 font-medium hover:border-border focus:border-accent"
          value={draft ?? n.name ?? ''}
          placeholder={nodeLabel(n)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => {
            setDraft(null);
            const name = e.target.value.trim().slice(0, 120);
            if (name !== (n.name ?? '')) meta({ name: name || null }, 'Rename layer');
          }}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      )}
      <div className="flex items-center gap-2">
        <span className="text-muted">
          {nodes.length > 1
            ? `${nodes.length} layers`
            : n.type === 'box' || n.type === 'text'
              ? `${n.type} · ${n.tag}`
              : n.type}
        </span>
        <div
          role="radiogroup"
          aria-label="Positioning"
          className="ml-auto flex rounded border border-border"
        >
          {(['flow', 'absolute'] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={n.positioning === p}
              disabled={readOnly || !n.parentId}
              className={`px-2 py-0.5 ${n.positioning === p ? 'bg-surface-2 font-medium' : ''}`}
              onClick={() =>
                n.positioning !== p &&
                meta({ positioning: p }, p === 'absolute' ? 'Make absolute' : 'Return to flow')
              }
            >
              {p === 'flow' ? 'Flow' : 'Absolute'}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            disabled={readOnly || !n.parentId}
            checked={!!n.hidden}
            onChange={(e) =>
              meta(
                { hidden: e.target.checked ? true : null },
                e.target.checked ? 'Hide layer' : 'Show layer',
              )
            }
          />
          Hidden
        </label>
      </div>
    </div>
  );
}

function NodeInspector({ ids, frame }: { ids: string[]; frame: Frame | undefined }) {
  const { designSystem } = useEditor();
  const readOnly = useDocStore((s) => s.readOnly);
  const nodes = useDocStore(
    useShallow((s) => ids.map((id) => s.doc.nodes[id]).filter((n): n is Node => !!n)),
  );
  const docStore = useDocStoreApi();
  const [bp, frameBp] = useEditBreakpoint(frame);
  const [open, setOpen] = useState<Set<string>>(DEFAULT_OPEN);
  const [filter, setFilter] = useState('');

  const tokens = useMemo(() => {
    const m = new Map<StylePropName, TokenOption[]>();
    for (const g of GROUPS) for (const p of g.props) m.set(p, tokensForProp(p, designSystem.spec));
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

  if (!nodes.length) return null;
  const primary = nodes[0]!;
  const styles = nodes.map((n) => n.style);
  const q = filter.trim().toLowerCase();

  return (
    <div data-testid="inspector">
      <NodeMeta key={primary.id} nodes={nodes} readOnly={readOnly} />
      <BreakpointTabs bp={bp} frameBp={frameBp} />
      <div className="px-3 pb-1">
        <input
          aria-label="Filter properties"
          placeholder="Filter properties"
          className="input py-1 text-xs"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {GROUPS.map((g) => {
        const props = q
          ? g.props.filter(
              (p) => p.toLowerCase().includes(q) || STYLE_PROPS[p].label.toLowerCase().includes(q),
            )
          : g.props;
        if (!props.length) return null;
        const isOpen = !!q || open.has(g.group);
        const setCount = props.filter((p) => styles.some((s) => propState(s, p, bp).from)).length;
        return (
          <Section
            key={g.group}
            title={`${g.label}${setCount ? ` · ${setCount}` : ''}`}
            open={isOpen}
            onToggle={() =>
              setOpen((o) => {
                const n = new Set(o);
                if (n.has(g.group)) n.delete(g.group);
                else n.add(g.group);
                return n;
              })
            }
          >
            {props.map((p) => (
              <StyleField
                key={p}
                prop={p}
                bp={bp}
                state={propState(primary.style, p, bp)}
                mixed={nodes.length > 1 && sharedValue(styles, p, bp) === 'mixed'}
                tokens={tokens.get(p)!}
                readOnly={readOnly}
                onApply={onApply}
              />
            ))}
          </Section>
        );
      })}
    </div>
  );
}

function FrameInspector({ frame }: { frame: Frame }) {
  const readOnly = useDocStore((s) => s.readOnly);
  const docStore = useDocStoreApi();
  const { designSystem } = useEditor();
  const update = (patch: Extract<DocOp, { op: 'updateFrame' }>['patch'], label: string) =>
    docStore
      .getState()
      .apply([{ op: 'updateFrame', id: frame.id, patch }], { source: 'inspector', label });
  const num = (
    label: string,
    value: number,
    min: number,
    max: number,
    set: (n: number) => void,
  ) => (
    <label className="flex items-center gap-2">
      <span className="w-16 text-muted">{label}</span>
      <input
        key={value}
        aria-label={`Frame ${label.toLowerCase()}`}
        type="number"
        disabled={readOnly}
        defaultValue={value}
        className="input py-0.5 text-xs"
        onBlur={(e) => {
          const n = Math.round(Number(e.target.value));
          if (Number.isFinite(n) && n !== value && n >= min && n <= max) set(n);
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
    </label>
  );
  return (
    <div data-testid="frame-inspector" className="space-y-2 p-3 text-xs">
      <div className="font-semibold">Frame</div>
      <label className="flex items-center gap-2">
        <span className="w-16 text-muted">Name</span>
        <input
          key={frame.name}
          aria-label="Frame name"
          disabled={readOnly}
          defaultValue={frame.name}
          maxLength={120}
          className="input py-0.5 text-xs"
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name && name !== frame.name) update({ name }, 'Rename frame');
          }}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </label>
      {num('Width', frame.width, 160, 4096, (width) => update({ width }, 'Resize frame'))}
      <label className="flex items-center gap-2">
        <span className="w-16 text-muted">Height</span>
        <input
          type="checkbox"
          aria-label="Auto height"
          disabled={readOnly}
          checked={frame.height === 'auto'}
          onChange={(e) => update({ height: e.target.checked ? 'auto' : 800 }, 'Frame height')}
        />
        <span>Auto</span>
      </label>
      {frame.height !== 'auto' &&
        num('Min height', frame.height, 80, 32768, (height) => update({ height }, 'Frame height'))}
      {num('X', Math.round(frame.canvas.x), -1e6, 1e6, (x) =>
        update({ canvas: { ...frame.canvas, x } }, 'Move frame'),
      )}
      {num('Y', Math.round(frame.canvas.y), -1e6, 1e6, (y) =>
        update({ canvas: { ...frame.canvas, y } }, 'Move frame'),
      )}
      <p className="text-muted">
        Renders at the {frameBreakpoint(frame, designSystem.spec)} breakpoint.
      </p>
    </div>
  );
}

export function InspectorPane() {
  const selection = useDocStore((s) => s.selection);
  const doc = useDocStore((s) => s.doc);
  const ids = selection.nodeIds.filter((id) => doc.nodes[id]);
  const frameId = ids.length
    ? (frameIndex(doc).get(ids[0]!) ?? selection.frameId)
    : selection.frameId;
  const frame = doc.frames.find((f) => f.id === frameId);
  if (ids.length) return <NodeInspector key={ids.join(',')} ids={ids} frame={frame} />;
  if (frame) return <FrameInspector key={frame.id} frame={frame} />;
  return <div className="p-4 text-sm text-muted">Select a frame or an element to edit it.</div>;
}
