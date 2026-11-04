/**
 * Live preview for the design-system editor (Story 4.1): a synthetic DesignDoc that renders
 * every token (swatches, type ramp, spacing bars, radii, shadows, numbers) and every component
 * (each variant combination). It's an ordinary DesignDoc, so the preview goes through the same
 * renderer (FrameView / renderFrameStatic) as the canvas and exports.
 */
import {
  resolveToken,
  SCHEMA_VERSION,
  type DesignDoc,
  type DesignSystemSpec,
  type Node,
  type ResponsiveStyle,
  type StyleProps,
  type TokenType,
} from '@crunch/doc-model';

export const PREVIEW_FRAME_ID = 'f_dspreview0';
/** Cap per component so a system with many variant axes stays readable (and fast). */
export const MAX_VARIANT_COMBOS = 12;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Draft = DistributiveOmit<Node, 'parentId' | 'children'> & { kids?: Draft[] };

class Builder {
  private n = 0;
  readonly nodes: Record<string, Node> = {};
  nextId(prefix = 'pv'): string {
    this.n += 1;
    return `n_${prefix}${String(this.n).padStart(6, '0')}`;
  }
  add(d: Draft, parentId: string | null): string {
    const { kids = [], ...rest } = d;
    const node = { ...rest, parentId, children: [] as string[] } as Node;
    this.nodes[node.id] = node;
    node.children = kids.map((k) => this.add(k, node.id));
    return node.id;
  }
}

const tok = (path: string) => ({ token: path });
const s = (base: StyleProps): ResponsiveStyle => ({ base });

function tokensOf(spec: DesignSystemSpec, ...types: TokenType[]): string[] {
  return Object.keys(spec.tokens)
    .filter((p) => types.includes(spec.tokens[p]!.type))
    .sort();
}

/** Display string for a token's resolved value (aliases shown as "→ target"). */
export function tokenDisplayValue(spec: DesignSystemSpec, path: string, theme?: string): string {
  const def = spec.tokens[path];
  if (!def) return '';
  try {
    const value = resolveToken(spec.tokens, path, theme ? spec.themes[theme] : undefined);
    const alias = typeof def.value === 'object' ? ` (→ ${def.value.ref})` : '';
    return `${value}${alias}`;
  } catch {
    return 'unresolved';
  }
}

/** Every combination of variant options, default-first, capped. */
export function variantCombos(
  variants: DesignSystemSpec['components'][string]['variants'],
  max = MAX_VARIANT_COMBOS,
): Record<string, string>[] {
  let combos: Record<string, string>[] = [{}];
  for (const [axis, v] of Object.entries(variants)) {
    const opts = [v.default, ...v.options.filter((o) => o !== v.default)];
    combos = combos.flatMap((c) => opts.map((o) => ({ ...c, [axis]: o })));
    if (combos.length > max) combos = combos.slice(0, max);
  }
  return combos;
}

function textNode(
  b: Builder,
  text: string,
  style: StyleProps,
  tag: 'p' | 'span' | 'h2' | 'h3' = 'p',
): Draft {
  return {
    id: b.nextId(),
    type: 'text',
    tag,
    positioning: 'flow',
    props: { text },
    style: s(style),
  };
}

function box(b: Builder, style: StyleProps, kids: Draft[] = [], name?: string): Draft {
  return {
    id: b.nextId(),
    type: 'box',
    tag: 'div',
    name,
    positioning: 'flow',
    props: {},
    style: s(style),
    kids,
  };
}

export interface PreviewOptions {
  theme?: string;
  /** Only render these sections (default: all). */
  sections?: PreviewSection[];
}
export type PreviewSection =
  | 'colors'
  | 'typography'
  | 'spacing'
  | 'radius'
  | 'shadows'
  | 'numbers'
  | 'breakpoints'
  | 'components';

const LABEL: StyleProps = { fontSize: 12, color: '#71717a', fontFamily: 'ui-monospace, monospace' };

export function buildPreviewDoc(spec: DesignSystemSpec, opts: PreviewOptions = {}): DesignDoc {
  const b = new Builder();
  const want = (sec: PreviewSection) => !opts.sections || opts.sections.includes(sec);
  const has = (p: string) => !!spec.tokens[p];
  const textColor = has('color.text') ? tok('color.text') : '#18181b';
  const sans = tokensOf(spec, 'fontFamily')[0];
  const label = (text: string) => textNode(b, text, LABEL, 'span');
  const section = (title: string, kids: Draft[], layout: StyleProps): Draft =>
    box(
      b,
      { display: 'flex', flexDirection: 'column', gap: 12 },
      [
        textNode(b, title, { fontSize: 18, fontWeight: 600, color: textColor }, 'h2'),
        box(b, layout, kids),
      ],
      title,
    );
  const grid = (min: number): StyleProps => ({
    display: 'grid',
    gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`,
    gap: 16,
  });
  const column: StyleProps = { display: 'flex', flexDirection: 'column', gap: 12 };
  const sections: Draft[] = [];
  const value = (p: string) => tokenDisplayValue(spec, p, opts.theme);

  const colors = tokensOf(spec, 'color');
  if (want('colors') && colors.length) {
    sections.push(
      section(
        'Colors',
        colors.map((p) =>
          box(b, { display: 'flex', flexDirection: 'column', gap: 4 }, [
            box(b, {
              height: 56,
              borderRadius: 8,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'rgba(0,0,0,0.12)',
              backgroundColor: tok(p),
            }),
            label(p),
            label(value(p)),
          ]),
        ),
        grid(120),
      ),
    );
  }

  if (want('typography')) {
    const rows: Draft[] = [];
    const sample = 'The quick brown fox jumps over the lazy dog';
    const row = (p: string, style: StyleProps, text = sample) =>
      box(b, { display: 'flex', flexDirection: 'column', gap: 2 }, [
        textNode(b, text, { color: textColor, ...style }),
        label(`${p} · ${value(p)}`),
      ]);
    for (const p of tokensOf(spec, 'fontFamily'))
      rows.push(row(p, { fontFamily: tok(p), fontSize: 20 }));
    for (const p of tokensOf(spec, 'fontSize'))
      rows.push(
        row(p, { fontSize: tok(p), ...(sans ? { fontFamily: tok(sans) } : {}) }, 'Aa Bb Cc 123'),
      );
    for (const p of tokensOf(spec, 'fontWeight'))
      rows.push(
        row(p, { fontWeight: tok(p), fontSize: 18, ...(sans ? { fontFamily: tok(sans) } : {}) }),
      );
    for (const p of tokensOf(spec, 'lineHeight'))
      rows.push(
        row(
          p,
          { lineHeight: tok(p), maxWidth: 420, fontSize: 14 },
          `${sample}. ${sample}. ${sample}.`,
        ),
      );
    if (rows.length) sections.push(section('Typography', rows, column));
  }

  const dims = tokensOf(spec, 'dimension');
  if (want('spacing') && dims.length) {
    sections.push(
      section(
        'Spacing',
        dims.map((p) =>
          box(b, { display: 'flex', alignItems: 'center', gap: 12 }, [
            box(b, { width: 180 }, [label(`${p} · ${value(p)}`)]),
            box(b, { width: tok(p), height: 12, borderRadius: 2, backgroundColor: '#818cf8' }),
          ]),
        ),
        { display: 'flex', flexDirection: 'column', gap: 8 },
      ),
    );
  }

  const radii = tokensOf(spec, 'radius');
  if (want('radius') && radii.length) {
    sections.push(
      section(
        'Radius',
        radii.map((p) =>
          box(b, { display: 'flex', flexDirection: 'column', gap: 4 }, [
            box(b, {
              width: 72,
              height: 72,
              borderRadius: tok(p),
              backgroundColor: '#e0e7ff',
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: '#a5b4fc',
            }),
            label(p),
          ]),
        ),
        grid(96),
      ),
    );
  }

  const shadows = tokensOf(spec, 'shadow');
  if (want('shadows') && shadows.length) {
    sections.push(
      section(
        'Shadows',
        shadows.map((p) =>
          box(b, { display: 'flex', flexDirection: 'column', gap: 8 }, [
            box(b, { height: 64, borderRadius: 8, backgroundColor: '#ffffff', boxShadow: tok(p) }),
            label(p),
          ]),
        ),
        { ...grid(140), paddingTop: 4, paddingBottom: 8 },
      ),
    );
  }

  const numbers = tokensOf(spec, 'number');
  if (want('numbers') && numbers.length) {
    sections.push(
      section(
        'Numbers',
        numbers.map((p) =>
          box(b, { display: 'flex', alignItems: 'center', gap: 12 }, [
            box(b, {
              width: 32,
              height: 32,
              borderRadius: 4,
              backgroundColor: '#6366f1',
              opacity: tok(p),
            }),
            label(`${p} · ${value(p)}`),
          ]),
        ),
        column,
      ),
    );
  }

  if (want('breakpoints')) {
    sections.push(
      section(
        'Breakpoints',
        [
          label(`base < ${spec.breakpoints.md}px`),
          label(`md ≥ ${spec.breakpoints.md}px`),
          label(`lg ≥ ${spec.breakpoints.lg}px`),
        ],
        { display: 'flex', gap: 24 },
      ),
    );
  }

  const components = Object.values(spec.components).sort((a, c) => a.name.localeCompare(c.name));
  if (want('components') && components.length) {
    sections.push(
      section(
        'Components',
        components.map((c) =>
          box(
            b,
            { display: 'flex', flexDirection: 'column', gap: 8 },
            [
              textNode(b, c.name, { fontSize: 15, fontWeight: 600, color: textColor }, 'h3'),
              ...(c.description ? [label(c.description)] : []),
              box(
                b,
                { display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' },
                variantCombos(c.variants).map((variant) =>
                  box(
                    b,
                    { display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' },
                    [
                      {
                        id: b.nextId('ci'),
                        type: 'instance',
                        name: c.name,
                        positioning: 'flow',
                        style: {},
                        componentRef: { componentId: c.id, variant },
                        props: { values: {} },
                      },
                      label(
                        Object.entries(variant)
                          .map(([k, v]) => `${k}=${v}`)
                          .join(' ') || 'default',
                      ),
                    ],
                  ),
                ),
              ),
            ],
            c.name,
          ),
        ),
        { display: 'flex', flexDirection: 'column', gap: 24 },
      ),
    );
  }

  const rootId = b.add(
    box(
      b,
      {
        display: 'flex',
        flexDirection: 'column',
        gap: 40,
        paddingTop: 32,
        paddingBottom: 32,
        paddingLeft: 32,
        paddingRight: 32,
        backgroundColor: has('color.background') ? tok('color.background') : '#ffffff',
        color: textColor,
        ...(sans ? { fontFamily: tok(sans) } : {}),
      },
      sections,
      'Design system preview',
    ),
    null,
  );
  return {
    schemaVersion: SCHEMA_VERSION,
    frames: [
      {
        id: PREVIEW_FRAME_ID,
        name: 'Preview',
        rootNodeId: rootId,
        canvas: { x: 0, y: 0 },
        width: 640,
        height: 'auto',
        previewBreakpoints: [],
      },
    ],
    nodes: b.nodes,
    sliders: [],
    tokenOverrides: {},
  };
}

/** A single component instance (the component editor's preview). */
export function buildComponentPreviewDoc(
  componentId: string,
  variant: Record<string, string>,
  values: Record<string, string | boolean>,
  background: StyleProps['backgroundColor'] = '#ffffff',
): DesignDoc {
  const rootId = 'n_cpvroot001';
  const instId = 'n_cpvinst001';
  return {
    schemaVersion: SCHEMA_VERSION,
    frames: [
      {
        id: 'f_cpreview01',
        name: 'Component',
        rootNodeId: rootId,
        canvas: { x: 0, y: 0 },
        width: 560,
        height: 'auto',
        previewBreakpoints: [],
      },
    ],
    nodes: {
      [rootId]: {
        id: rootId,
        type: 'box',
        tag: 'div',
        parentId: null,
        children: [instId],
        positioning: 'flow',
        props: {},
        style: s({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 160,
          paddingTop: 24,
          paddingBottom: 24,
          paddingLeft: 24,
          paddingRight: 24,
          backgroundColor: background,
        }),
      },
      [instId]: {
        id: instId,
        type: 'instance',
        parentId: rootId,
        children: [],
        positioning: 'flow',
        style: {},
        componentRef: { componentId, variant },
        props: { values },
      },
    },
    sliders: [],
    tokenOverrides: {},
  };
}
