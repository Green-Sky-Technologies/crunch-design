'use client';

/**
 * Edit-panel property tabs for a node selection (Story 3.3). Simple: the handful of properties
 * people change most. Pro: every property in grouped sections (Text, Sizing, Layout, Position,
 * Fill, Stroke, Radius, Effects, plus component/image props), and "All properties" for the rest
 * of the allowlist, so every StyleProp stays editable. Multi-selection shows shared values (or
 * "Mixed") and edits every node.
 */
import {
  inspectorGroups,
  isContainer,
  layerName,
  nodeTag,
  sizingMode,
  type SizingMode,
} from '@crunch/canvas';
import {
  STYLE_PROPS,
  isTokenRef,
  type DocOp,
  type ImageNode,
  type InstanceNode,
  type StylePropName,
  type TextNode,
} from '@crunch/doc-model';
import { useState } from 'react';
import { useDocStoreApi, useEditor } from '../doc-store';
import { useCanvas } from './canvas-store';
import { frameIndex } from './context';
import { nodeElement } from './dom';
import { positioningOps } from './drag';
import { AlignGrid, Field, FieldGrid, LinkedSides, Section, Segmented, Toggle } from './fields';
import { BreakpointTabs, MIXED, useStyle } from './style-editing';

/* ------------------------------------------------------------------ prop sets */

const TEXT_PROPS = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'color',
  'fontStyle',
  'textDecoration',
  'textAlign',
  'lineHeight',
  'letterSpacing',
  'textTransform',
] as const satisfies readonly StylePropName[];
const SIZE_PROPS = [
  'width',
  'height',
  'maxWidth',
  'flexGrow',
  'alignSelf',
  'minWidth',
  'minHeight',
  'maxHeight',
] as const satisfies readonly StylePropName[];
const PADDING = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const;
const LAYOUT_PROPS = [
  'display',
  'flexDirection',
  'flexWrap',
  'justifyContent',
  'alignItems',
  'gap',
  'gridTemplateColumns',
  'gridTemplateRows',
  ...PADDING,
] as const satisfies readonly StylePropName[];
/**
 * Props whose dedicated controls only offer common values (direction, alignment grid, toggles):
 * they're also listed under "All properties" so every keyword stays reachable.
 */
const PARTIAL = new Set<StylePropName>([
  'display',
  'flexDirection',
  'flexWrap',
  'justifyContent',
  'alignItems',
  'fontStyle',
  'textDecoration',
  'textAlign',
]);
const POSITION_PROPS = ['left', 'top'] as const satisfies readonly StylePropName[];
const FILL_PROPS = ['backgroundColor', 'opacity'] as const satisfies readonly StylePropName[];
const BORDER_SIDES = [
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
] as const;
const STROKE_PROPS = [
  'borderWidth',
  'borderStyle',
  'borderColor',
  ...BORDER_SIDES,
] as const satisfies readonly StylePropName[];
const CORNERS = [
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomRightRadius',
  'borderBottomLeftRadius',
] as const;
const RADIUS_PROPS = ['borderRadius', ...CORNERS] as const satisfies readonly StylePropName[];
const EFFECT_PROPS = ['boxShadow', 'blur'] as const satisfies readonly StylePropName[];

/* ------------------------------------------------------------------ helpers */

/** Rendered size of the primary node, refreshed on doc and layout changes. */
function useComputedSize(): { width?: number; height?: number } {
  const s = useStyle();
  useCanvas((c) => c.layoutTick);
  const frameId = frameIndex(useDocStoreApi().getState().doc).get(s.primary.id);
  const el = frameId ? nodeElement(document, frameId, s.primary.id) : null;
  return el ? { width: el.offsetWidth, height: el.offsetHeight } : {};
}

const WEIGHTS: [number, string][] = [
  [100, 'Thin'],
  [200, 'Extra light'],
  [300, 'Light'],
  [400, 'Regular'],
  [500, 'Medium'],
  [600, 'Semibold'],
  [700, 'Bold'],
  [800, 'Extra bold'],
  [900, 'Black'],
];

/** Font weight as named steps (Thin…Black). A token value shows as the token. */
function WeightField() {
  const s = useStyle();
  const v = s.value('fontWeight');
  const token = isTokenRef(v) ? v.token : null;
  const num = v === 'bold' ? 700 : v === 'normal' ? 400 : typeof v === 'number' ? v : null;
  return (
    <label
      data-prop="fontWeight"
      className="flex h-7 min-w-0 items-center gap-1 rounded-md bg-surface-2 px-2 text-xs"
    >
      <span className="flex shrink-0 items-center gap-1 text-muted">
        {s.isSet('fontWeight') && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
        Weight
      </span>
      <select
        aria-label="Weight"
        disabled={s.readOnly}
        className={`min-w-0 flex-1 cursor-pointer bg-transparent text-right outline-none ${
          s.state('fontWeight').inherited ? 'text-muted' : ''
        }`}
        value={v === MIXED ? '' : token ? `token:${token}` : num === null ? '' : String(num)}
        onChange={(e) => {
          const raw = e.target.value;
          s.onApply('fontWeight', raw === '' ? null : Number(raw));
        }}
      >
        <option value="">{v === MIXED ? 'Mixed' : '—'}</option>
        {token && <option value={`token:${token}`}>◇ {token}</option>}
        {WEIGHTS.map(([w, name]) => (
          <option key={w} value={w}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Text content of text nodes (inline input; commits on Enter or blur). */
function ContentField() {
  const s = useStyle();
  const docStore = useDocStoreApi();
  const texts = s.nodes.filter((n): n is TextNode => n.type === 'text');
  const shared = texts.every((n) => n.props.text === texts[0]?.props.text);
  const current = shared ? (texts[0]?.props.text ?? '') : '';
  const [draft, setDraft] = useState<string | null>(null);
  if (!texts.length) return null;
  const commit = (text: string) => {
    setDraft(null);
    if (shared && text === current) return;
    docStore.getState().apply(
      texts.map((n) => ({ op: 'setProps' as const, id: n.id, patch: { text } })),
      { source: 'inspector', label: 'Edit text' },
    );
  };
  return (
    <label className="flex min-h-7 items-center gap-2 rounded-md bg-surface-2 px-2 text-xs focus-within:ring-1 focus-within:ring-accent">
      <span className="shrink-0 text-muted">Content</span>
      <input
        aria-label="Content"
        disabled={s.readOnly}
        placeholder={shared ? '' : 'Mixed'}
        className="min-w-0 flex-1 bg-transparent py-1 text-right outline-none"
        value={draft ?? current}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => draft !== null && commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

const ALIGN_ICONS: Record<string, string> = {
  left: '⇤',
  center: '↔',
  right: '⇥',
  justify: '☰',
};

function TextAlign() {
  const s = useStyle();
  const v = s.value('textAlign');
  return (
    <Segmented
      label="Text align"
      value={typeof v === 'string' ? (v as 'left') : null}
      disabled={s.readOnly}
      className="flex-1"
      options={(['left', 'center', 'right', 'justify'] as const).map((a) => ({
        value: a,
        label: <span aria-hidden>{ALIGN_ICONS[a]}</span>,
        title: `Align ${a}`,
      }))}
      onChange={(a) => s.onApply('textAlign', a)}
    />
  );
}

function TextStyleToggles() {
  const s = useStyle();
  const deco = s.value('textDecoration');
  return (
    <div className="flex gap-1">
      <Toggle
        label="Italic"
        pressed={s.value('fontStyle') === 'italic'}
        disabled={s.readOnly}
        onChange={(on) => s.onApply('fontStyle', on ? 'italic' : null)}
      >
        <i className="font-serif">I</i>
      </Toggle>
      <Toggle
        label="Underline"
        pressed={deco === 'underline'}
        disabled={s.readOnly}
        onChange={(on) => s.onApply('textDecoration', on ? 'underline' : null)}
      >
        <u>U</u>
      </Toggle>
      <Toggle
        label="Strikethrough"
        pressed={deco === 'line-through'}
        disabled={s.readOnly}
        onChange={(on) => s.onApply('textDecoration', on ? 'line-through' : null)}
      >
        <s>S</s>
      </Toggle>
    </div>
  );
}

/** Hug / Fixed / Fill (Story 3.5). Fixed pins the current rendered size. */
export function SizingControl({ axis }: { axis: 'width' | 'height' }) {
  const s = useStyle();
  const docStore = useDocStoreApi();
  const v = s.value(axis);
  const mode: SizingMode | null = v === MIXED ? null : sizingMode(v);
  const set = (m: 'hug' | 'fixed' | 'fill') => {
    const index = frameIndex(docStore.getState().doc);
    const ops: DocOp[] = s.nodes.map((x) => {
      let value: unknown = m;
      if (m === 'fixed') {
        const el = nodeElement(document, index.get(x.id) ?? '', x.id);
        value = Math.max(
          1,
          Math.round(axis === 'width' ? (el?.offsetWidth ?? 100) : (el?.offsetHeight ?? 100)),
        );
      }
      return { op: 'setStyle', id: x.id, breakpoint: s.bp, prop: axis, value };
    });
    s.apply(ops, `${axis === 'width' ? 'Width' : 'Height'}: ${m}`);
  };
  return (
    <Segmented
      label={`${axis} sizing`}
      value={mode === 'auto' ? null : mode}
      disabled={s.readOnly}
      className="w-[132px] shrink-0"
      options={[
        { value: 'hug', label: 'Hug', title: 'Hug contents' },
        { value: 'fixed', label: 'Fixed', title: 'Fixed size' },
        { value: 'fill', label: 'Fill', title: 'Fill container' },
      ]}
      onChange={set}
    />
  );
}

function SizeRow({ axis, computed }: { axis: 'width' | 'height'; computed?: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="min-w-0 flex-1">
        <Field prop={axis} label={axis === 'width' ? 'Width' : 'Height'} computed={computed} />
      </div>
      <SizingControl axis={axis} />
    </div>
  );
}

/* ------------------------------------------------------------------ sections */

function TextSection() {
  return (
    <Section title="Text" props={TEXT_PROPS}>
      <ContentField />
      <FieldGrid>
        <Field prop="fontFamily" label="Font" wide />
        <Field prop="fontSize" label="Size" />
        <WeightField />
        <Field prop="color" label="Color" wide />
        <Field prop="lineHeight" label="Leading" />
        <Field prop="letterSpacing" label="Tracking" numberUnit="em" />
      </FieldGrid>
      <div className="flex items-center gap-1.5">
        <TextStyleToggles />
        <TextAlign />
      </div>
      <Field prop="textTransform" label="Case" />
    </Section>
  );
}

const EXTRA_SIZES = [
  ['minWidth', 'min width', 'Min W'],
  ['minHeight', 'min height', 'Min H'],
  ['maxHeight', 'max height', 'Max H'],
] as const;

function SizingSection() {
  const s = useStyle();
  const size = useComputedSize();
  const [shown, setShown] = useState<Set<string>>(new Set());
  const visible = EXTRA_SIZES.filter(([p]) => shown.has(p) || s.value(p) != null);
  const hidden = EXTRA_SIZES.filter(([p]) => !visible.some(([q]) => q === p));
  return (
    <Section title="Sizing" props={SIZE_PROPS}>
      <SizeRow axis="width" computed={size.width} />
      <SizeRow axis="height" computed={size.height} />
      <FieldGrid>
        <Field prop="maxWidth" label="Max W" />
        <Field prop="flexGrow" label="Grow" />
        <Field prop="alignSelf" label="Align self" wide />
        {visible.map(([p, , short]) => (
          <Field key={p} prop={p} label={short} />
        ))}
      </FieldGrid>
      {hidden.length > 0 && !s.readOnly && (
        <p className="text-[11px] text-muted">
          Add:{' '}
          {hidden.map(([p, name], i) => (
            <span key={p}>
              {i > 0 && ' · '}
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => setShown((x) => new Set(x).add(p))}
              >
                {name}
              </button>
            </span>
          ))}
        </p>
      )}
    </Section>
  );
}

type Direction = 'row' | 'column' | 'grid';

/** Props the Layout section renders fields for, given the container's display. */
function layoutShown(display: unknown): StylePropName[] {
  const flex = display === 'flex' || display === 'inline-flex';
  return [
    ...PADDING,
    ...(flex || display === 'grid' ? (['gap'] as const) : []),
    ...(display === 'grid' ? (['gridTemplateColumns', 'gridTemplateRows'] as const) : []),
  ];
}

function LayoutSection() {
  const s = useStyle();
  const display = s.value('display');
  const dir = s.value('flexDirection');
  const flex = display === 'flex' || display === 'inline-flex';
  const direction: Direction | null =
    display === 'grid'
      ? 'grid'
      : flex
        ? dir === 'column' || dir === 'column-reverse'
          ? 'column'
          : 'row'
        : null;
  const setDirection = (d: Direction) => {
    if (d === 'grid')
      s.applyMany(
        [
          ['display', 'grid'],
          ...(s.value('gridTemplateColumns') == null
            ? ([['gridTemplateColumns', 'repeat(2, 1fr)']] as [StylePropName, unknown][])
            : []),
        ],
        'Layout: grid',
      );
    else
      s.applyMany(
        [
          ['display', 'flex'],
          ['flexDirection', d],
        ],
        `Layout: ${d}`,
      );
  };
  const wrap = s.value('flexWrap') === 'wrap';
  const between = s.value('justifyContent') === 'space-between';
  return (
    <Section title="Layout" props={LAYOUT_PROPS}>
      <Segmented
        label="Direction"
        value={direction}
        disabled={s.readOnly}
        options={[
          { value: 'row', label: '→ Row' },
          { value: 'column', label: '↓ Column' },
          { value: 'grid', label: '⊞ Grid' },
        ]}
        onChange={setDirection}
      />
      {flex && (
        <div className="flex gap-1.5">
          <AlignGrid />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Field prop="gap" label="Gap" />
            <div className="flex gap-1">
              <Toggle
                label="Wrap"
                pressed={wrap}
                disabled={s.readOnly}
                onChange={(on) => s.onApply('flexWrap', on ? 'wrap' : null)}
              >
                Wrap
              </Toggle>
              <Toggle
                label="Space between"
                pressed={between}
                disabled={s.readOnly}
                onChange={(on) => s.onApply('justifyContent', on ? 'space-between' : null)}
              >
                Space between
              </Toggle>
            </div>
          </div>
        </div>
      )}
      {direction === 'grid' && (
        <FieldGrid>
          <Field prop="gridTemplateColumns" label="Columns" wide />
          <Field prop="gridTemplateRows" label="Rows" wide />
          <Field prop="gap" label="Gap" />
        </FieldGrid>
      )}
      <LinkedSides label="Padding" props={PADDING} sideLabels={['T', 'R', 'B', 'L']} />
    </Section>
  );
}

function PositionSection() {
  const s = useStyle();
  const docStore = useDocStoreApi();
  const all = (p: 'flow' | 'absolute') => s.nodes.every((n) => n.positioning === p);
  const value = all('absolute') ? 'absolute' : all('flow') ? 'flow' : null;
  return (
    <Section title="Position" props={POSITION_PROPS}>
      <Segmented
        label="Positioning"
        value={value}
        disabled={s.readOnly}
        options={[
          { value: 'flow', label: 'Flow', title: 'In the layout flow' },
          { value: 'absolute', label: 'Absolute', title: 'Free x/y placement' },
        ]}
        onChange={(p) => {
          // Per node: only those not already `p` change; they stay where they are on screen.
          const todo = s.nodes.filter((x) => x.positioning !== p).map((x) => x.id);
          const st = docStore.getState();
          s.apply(
            positioningOps(st.doc, todo, p, s.bp, document),
            p === 'absolute' ? 'Make absolute' : 'Return to flow',
          );
        }}
      />
      {value === 'absolute' && (
        <FieldGrid>
          <Field prop="left" label="X" />
          <Field prop="top" label="Y" />
        </FieldGrid>
      )}
    </Section>
  );
}

function FillSection() {
  return (
    <Section title="Fill" props={FILL_PROPS}>
      <FieldGrid>
        <Field prop="backgroundColor" label="Background" wide />
        <Field prop="opacity" label="Opacity" />
      </FieldGrid>
    </Section>
  );
}

function StrokeSection() {
  const s = useStyle();
  const [perSide, setPerSide] = useState(() => BORDER_SIDES.some((p) => s.value(p) != null));
  return (
    <Section title="Stroke" props={STROKE_PROPS}>
      <FieldGrid>
        <Field prop="borderWidth" label="Width" />
        <Field prop="borderStyle" label="Style" />
        <Field prop="borderColor" label="Color" wide />
      </FieldGrid>
      <Toggle label="Per-side widths" pressed={perSide} onChange={setPerSide}>
        Per side
      </Toggle>
      {perSide && (
        <FieldGrid>
          {BORDER_SIDES.map((p, i) => (
            <Field key={p} prop={p} label={['Top', 'Right', 'Bottom', 'Left'][i]} />
          ))}
        </FieldGrid>
      )}
    </Section>
  );
}

function RadiusSection() {
  const s = useStyle();
  const [perCorner, setPerCorner] = useState(() => CORNERS.some((p) => s.value(p) != null));
  return (
    <Section title="Radius" props={RADIUS_PROPS}>
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <Field prop="borderRadius" label="Radius" />
        </div>
        <Toggle label="Per-corner radius" pressed={perCorner} onChange={setPerCorner}>
          ⌜⌟
        </Toggle>
      </div>
      {perCorner && (
        <FieldGrid>
          {CORNERS.map((p, i) => (
            <Field key={p} prop={p} label={['TL', 'TR', 'BR', 'BL'][i]} />
          ))}
        </FieldGrid>
      )}
    </Section>
  );
}

function EffectsSection() {
  return (
    <Section title="Effects" props={EFFECT_PROPS}>
      <FieldGrid>
        <Field prop="boxShadow" label="Shadow" wide />
        <Field prop="blur" label="Blur" />
      </FieldGrid>
    </Section>
  );
}

/** Component instance: variant axes and prop values (setInstance). */
function ComponentSection({ node }: { node: InstanceNode }) {
  const s = useStyle();
  const { designSystem } = useEditor();
  const def = designSystem.spec.components[node.componentRef.componentId];
  if (!def) return null;
  const set = (patch: Omit<Extract<DocOp, { op: 'setInstance' }>, 'op' | 'id'>, label: string) =>
    s.apply([{ op: 'setInstance', id: node.id, ...patch }], label);
  return (
    <section className="space-y-1.5 border-b border-border px-3 py-2.5" aria-label="Component">
      <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">{def.name}</h3>
      {Object.entries(def.variants).map(([axis, v]) => (
        <label
          key={axis}
          className="flex h-7 items-center gap-2 rounded-md bg-surface-2 px-2 text-xs"
        >
          <span className="text-muted capitalize">{axis}</span>
          <select
            aria-label={axis}
            disabled={s.readOnly}
            className="min-w-0 flex-1 bg-transparent text-right outline-none"
            value={node.componentRef.variant[axis] ?? v.default}
            onChange={(e) => set({ variant: { [axis]: e.target.value } }, `Set ${axis}`)}
          >
            {v.options.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
      ))}
      {Object.entries(def.props).map(([name, p]) => {
        const value = node.props.values[name] ?? p.default;
        return p.type === 'boolean' ? (
          <label key={name} className="flex h-7 items-center gap-2 px-2 text-xs">
            <input
              type="checkbox"
              disabled={s.readOnly}
              checked={!!value}
              onChange={(e) => set({ values: { [name]: e.target.checked } }, `Set ${name}`)}
            />
            {name}
          </label>
        ) : (
          <label
            key={name}
            className="flex h-7 items-center gap-2 rounded-md bg-surface-2 px-2 text-xs"
          >
            <span className="shrink-0 text-muted">{name}</span>
            <input
              key={String(value)}
              aria-label={name}
              disabled={s.readOnly}
              defaultValue={String(value)}
              className="min-w-0 flex-1 bg-transparent text-right outline-none"
              onBlur={(e) =>
                e.target.value !== String(value) &&
                set({ values: { [name]: e.target.value } }, `Set ${name}`)
              }
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
          </label>
        );
      })}
    </section>
  );
}

function ImageSection({ node }: { node: ImageNode }) {
  const s = useStyle();
  const [error, setError] = useState<string | null>(null);
  const setProps = (patch: Record<string, string>, label: string) => {
    if (!s.apply([{ op: 'setProps', id: node.id, patch }], label)) setError('Invalid value');
    else setError(null);
  };
  const input = (name: 'src' | 'alt', label: string) => (
    <label className="flex h-7 items-center gap-2 rounded-md bg-surface-2 px-2 text-xs">
      <span className="shrink-0 text-muted">{label}</span>
      <input
        key={node.props[name]}
        aria-label={`Image ${name === 'src' ? 'URL' : 'alt text'}`}
        aria-invalid={name === 'src' && !!error}
        disabled={s.readOnly}
        defaultValue={node.props[name]}
        className="min-w-0 flex-1 bg-transparent text-right outline-none"
        onBlur={(e) =>
          e.target.value !== node.props[name] &&
          setProps({ [name]: e.target.value }, name === 'src' ? 'Set image' : 'Set alt text')
        }
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
    </label>
  );
  return (
    <section className="space-y-1.5 border-b border-border px-3 py-2.5" aria-label="Image">
      <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">Image</h3>
      {input('src', 'URL')}
      {input('alt', 'Alt')}
      <Field prop="objectFit" label="Fit" />
      {error && <p className="text-[11px] text-danger">Use an https:// image URL.</p>}
    </section>
  );
}

/** Every allowlisted prop the visible sections don't cover, grouped, with a filter. */
function AllProperties({ covered }: { covered: ReadonlySet<StylePropName> }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  return (
    <section className="px-3 py-2.5" aria-label="All properties">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center justify-between text-[11px] font-semibold tracking-wide text-muted uppercase"
        onClick={() => setOpen((o) => !o)}
      >
        All properties <span>{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <input
            aria-label="Filter properties"
            placeholder="Filter properties"
            className="input py-1 text-xs"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {inspectorGroups().map((g) => {
            const props = g.props.filter(
              (p) =>
                !covered.has(p) &&
                (!query ||
                  p.toLowerCase().includes(query) ||
                  STYLE_PROPS[p].label.toLowerCase().includes(query)),
            );
            if (!props.length) return null;
            return (
              <div key={g.group} className="space-y-1">
                <div className="text-[11px] text-muted">{g.label}</div>
                <div className="space-y-1">
                  {props.map((p) => (
                    <Field key={p} prop={p} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ header */

/** Selection header: layer name, type · tag, lock and hide, and the breakpoint selector. */
function NodeHeader() {
  const s = useStyle();
  const { designSystem } = useEditor();
  const docStore = useDocStoreApi();
  const n = s.primary;
  const [draft, setDraft] = useState<string | null>(null);
  const meta = (patch: Extract<DocOp, { op: 'setNodeMeta' }>['patch'], label: string) =>
    docStore.getState().apply(
      s.nodes.map((x) => ({ op: 'setNodeMeta' as const, id: x.id, patch })),
      { source: 'inspector', label },
    );
  const componentName =
    n.type === 'instance'
      ? designSystem.spec.components[n.componentRef.componentId]?.name
      : undefined;
  const allLocked = s.nodes.every((x) => !!x.locked);
  const allHidden = s.nodes.every((x) => !!x.hidden);
  const root = s.nodes.some((x) => !x.parentId);
  return (
    <div className="space-y-2 border-b border-border px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        {s.nodes.length === 1 ? (
          <input
            aria-label="Layer name"
            disabled={s.readOnly}
            className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-medium hover:border-border focus:border-accent focus:outline-none"
            value={draft ?? n.name ?? ''}
            placeholder={layerName(n, componentName)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => {
              setDraft(null);
              const name = e.target.value.trim().slice(0, 120);
              if (name !== (n.name ?? '')) meta({ name: name || null }, 'Rename layer');
            }}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        ) : (
          <span className="flex-1 px-1 text-sm font-medium">{s.nodes.length} layers</span>
        )}
        <span className="font-mono text-[11px] text-muted">
          {s.nodes.length === 1 ? nodeTag(n) : ''}
        </span>
        <Toggle
          label={allLocked ? 'Unlock' : 'Lock'}
          pressed={allLocked}
          disabled={s.docReadOnly || root}
          onChange={(on) => meta({ locked: on ? true : null }, on ? 'Lock layer' : 'Unlock layer')}
        >
          {allLocked ? '🔒' : '🔓'}
        </Toggle>
        <Toggle
          label={allHidden ? 'Show' : 'Hide'}
          pressed={allHidden}
          disabled={s.readOnly || root}
          onChange={(on) => meta({ hidden: on ? true : null }, on ? 'Hide layer' : 'Show layer')}
        >
          {allHidden ? '◌' : '●'}
        </Toggle>
      </div>
      <BreakpointTabs bp={s.bp} frameBp={s.frameBp} frameId={s.frame?.id} />
      {s.locked && (
        <p className="rounded bg-surface-2 px-2 py-1 text-xs text-muted">
          Locked layers can&apos;t be edited. Unlock to make changes.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ tabs */

export function SimpleTab() {
  const s = useStyle();
  const size = useComputedSize();
  const hasText = s.nodes.some((n) => n.type === 'text');
  const boxes = s.nodes.every((n) => isContainer(n));
  return (
    <div data-testid="simple-tab">
      <NodeHeader />
      <div className="space-y-1.5 px-3 py-2.5">
        {hasText && (
          <>
            <ContentField />
            <FieldGrid>
              <Field prop="color" label="Color" wide />
              <Field prop="fontSize" label="Size" />
              <WeightField />
            </FieldGrid>
            <TextAlign />
          </>
        )}
        <SizeRow axis="width" computed={size.width} />
        <FieldGrid>
          <Field prop="backgroundColor" label="Background" wide />
          <Field prop="borderRadius" label="Radius" />
        </FieldGrid>
        {boxes && <LinkedSides label="Padding" props={PADDING} sideLabels={['T', 'R', 'B', 'L']} />}
      </div>
    </div>
  );
}

export function ProTab() {
  const s = useStyle();
  const n = s.primary;
  const single = s.nodes.length === 1;
  const text = s.nodes.every((x) => x.type === 'text');
  const containers = s.nodes.every((x) => isContainer(x));
  const positioned = s.nodes.every((x) => !!x.parentId);
  const shown = new Set<StylePropName>([
    ...SIZE_PROPS,
    ...FILL_PROPS,
    ...STROKE_PROPS,
    ...RADIUS_PROPS,
    ...EFFECT_PROPS,
    ...(text ? TEXT_PROPS : []),
    ...(containers ? layoutShown(s.value('display')) : []),
    ...(positioned && s.nodes.every((x) => x.positioning === 'absolute') ? POSITION_PROPS : []),
    ...(single && n.type === 'image' ? (['objectFit'] as const) : []),
  ]);
  const covered = new Set([...shown].filter((p) => !PARTIAL.has(p)));
  return (
    <div data-testid="pro-tab">
      <NodeHeader />
      {single && n.type === 'instance' && <ComponentSection node={n} />}
      {single && n.type === 'image' && <ImageSection node={n} />}
      {text && <TextSection />}
      <SizingSection />
      {containers && <LayoutSection />}
      {positioned && <PositionSection />}
      <FillSection />
      <StrokeSection />
      <RadiusSection />
      <EffectsSection />
      <AllProperties covered={covered} />
    </div>
  );
}
