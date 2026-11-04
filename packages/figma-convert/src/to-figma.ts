/**
 * DesignDoc -> Figma push plan (Story 8.2).
 *
 * Each frame is converted at one breakpoint (picked from the push width). Flow layout becomes
 * auto-layout (direction, gap, padding, alignment, wrap, hug/fill/fixed sizing); absolute
 * positioning becomes absolute children. Token-bound values keep their resolved literal and
 * a variable binding. Design-system instances become instances of pushed Figma components.
 * Anything that can't be represented goes into the report rather than being silently dropped.
 */
import {
  BREAKPOINTS,
  isTokenRef,
  resolveToken,
  TokenResolutionError,
  type Breakpoint,
  type ComponentDef,
  type DesignDoc,
  type DesignSystemSpec,
  type Frame,
  type InstanceNode,
  type Node,
  type ResponsiveStyle,
  type StyleProps,
} from '@crunch/doc-model';
import { parseCssColor } from './color';
import { parseBoxShadow, parseGradient } from './css-values';
import type {
  BindableField,
  ComponentSpec,
  EffectSpec,
  FrameSpec,
  ImageSpec,
  InstanceSpec,
  NodeSpec,
  PaintSpec,
  PushPlan,
  Rgba,
  Sizing,
  SvgSpec,
  TextSpec,
} from './plan';
import { hashValue } from './reconcile';
import { Reporter } from './report';
import { roundPx, toPx } from './units';
import { primaryFamily, tokensToVariables, variableTypeFor } from './variables';

export interface DocToFigmaOptions {
  projectId: string;
  docVersion: number;
  /** Frames to push (default: all). */
  frameIds?: string[];
  /** Push width in px; picks the breakpoint. Default: each frame's own width. */
  width?: number;
  /** Include tokens as Figma variables and bind them (default true). */
  variables?: boolean;
}

const MAX_SPEC_NODES = 10_000;

/** Breakpoint a viewport width renders at. */
export function breakpointForWidth(width: number, bps: { md: number; lg: number }): Breakpoint {
  return width >= bps.lg ? 'lg' : width >= bps.md ? 'md' : 'base';
}

/** Effective style at a breakpoint (mobile-first cascade). */
export function effectiveStyle(style: ResponsiveStyle, bp: Breakpoint): StyleProps {
  const out: StyleProps = {};
  for (const b of BREAKPOINTS) {
    Object.assign(out, style[b] ?? {});
    if (b === bp) break;
  }
  return out;
}

const TYPO_PROPS = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'textTransform',
  'textDecoration',
  'whiteSpace',
  'color',
] as const satisfies readonly (keyof StyleProps)[];
type Inherited = Pick<StyleProps, (typeof TYPO_PROPS)[number]>;

/** Props handled by the mapping; anything else set on a node is reported. */
const HANDLED = new Set<string>([
  ...TYPO_PROPS,
  'display',
  'flexDirection',
  'flexWrap',
  'justifyContent',
  'alignItems',
  'gap',
  'rowGap',
  'columnGap',
  'overflow',
  'alignSelf',
  'flexGrow',
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'top',
  'right',
  'bottom',
  'left',
  'backgroundColor',
  'backgroundImage',
  'objectFit',
  'borderWidth',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderStyle',
  'borderColor',
  'borderRadius',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomRightRadius',
  'borderBottomLeftRadius',
  'opacity',
  'boxShadow',
  'rotate',
  'blur',
  'order',
  'aspectRatio',
  'cursor',
  'zIndex',
  'flexShrink',
]);

const UNSUPPORTED: Record<string, string> = {
  marginTop: 'Margins have no auto-layout equivalent; use gap or padding',
  marginRight: 'Margins have no auto-layout equivalent; use gap or padding',
  marginBottom: 'Margins have no auto-layout equivalent; use gap or padding',
  marginLeft: 'Margins have no auto-layout equivalent; use gap or padding',
  gridTemplateColumns: 'CSS grid is approximated as a wrapping row',
  gridTemplateRows: 'CSS grid is approximated as a wrapping row',
  gridColumn: 'Grid placement is not representable',
  gridRow: 'Grid placement is not representable',
  alignContent: 'align-content is not representable',
  flexBasis: 'flex-basis is not representable',
  scale: 'scale transforms are not pushed',
  translateX: 'translate offsets are not pushed',
  translateY: 'translate offsets are not pushed',
};

interface ParentCtx {
  mode: 'NONE' | 'HORIZONTAL' | 'VERTICAL';
  /** CSS align-items of the parent (cross-axis default for children). */
  alignItems: string;
  /** Parent content box size per axis, when known (FIXED or FILL from a known width). */
  width: number | null;
  height: number | null;
  /** Whether the parent's own size on each axis is determined by its children (HUG). */
  hug: { horizontal: boolean; vertical: boolean };
}

interface Resolved<T> {
  value: T | undefined;
  token?: string;
}

class Converter {
  readonly report = new Reporter();
  readonly components = new Map<string, ComponentSpec>();
  private count = 0;
  private bp: Breakpoint = 'base';
  private viewport = { width: 1280, height: 800 };
  private boundTokens: Set<string>;

  constructor(
    private readonly doc: DesignDoc,
    private readonly ds: DesignSystemSpec,
    bindVariables: boolean,
  ) {
    this.boundTokens = new Set(
      bindVariables
        ? Object.keys(ds.tokens).filter(
            (p) =>
              variableTypeFor(ds.tokens[p]!.type) !== null && !(p in (doc.tokenOverrides ?? {})),
          )
        : [],
    );
  }

  // ---------------------------------------------------------------- values

  private resolve<T = unknown>(value: unknown, at: Node): Resolved<T> {
    if (!isTokenRef(value)) return { value: value as T | undefined };
    const path = value.token;
    const override = this.doc.tokenOverrides?.[path];
    if (override !== undefined) {
      this.report.info('Project token override pushed as a literal value', { subject: path });
      return { value: override as T };
    }
    try {
      const v = resolveToken(this.ds.tokens, path);
      return { value: v as T, token: this.boundTokens.has(path) ? path : undefined };
    } catch (e) {
      if (e instanceof TokenResolutionError) {
        this.report.warn(`Unknown token "${path}"; value dropped`, {
          nodeId: at.id,
          nodeName: at.name,
          subject: path,
        });
        return { value: undefined };
      }
      throw e;
    }
  }

  private px(
    value: unknown,
    at: Node,
    fontSize: number,
    percentOf?: number | null,
  ): Resolved<number> {
    const r = this.resolve(value, at);
    if (r.value === undefined) return { value: undefined };
    const n = toPx(r.value, {
      fontSize,
      percentOf: percentOf ?? undefined,
      viewport: this.viewport,
    });
    if (n === null) {
      this.report.warn(`Length "${String(r.value)}" can't be resolved to px; ignored`, {
        nodeId: at.id,
        nodeName: at.name,
      });
      return { value: undefined };
    }
    return { value: roundPx(n), token: r.token };
  }

  private color(value: unknown, at: Node, inheritedColor?: unknown): Resolved<Rgba> {
    const r = this.resolve<string>(value, at);
    if (r.value === undefined) return { value: undefined };
    if (r.value === 'currentColor') {
      return inheritedColor !== undefined
        ? this.color(inheritedColor, at)
        : { value: { r: 0, g: 0, b: 0, a: 1 } };
    }
    const c = parseCssColor(String(r.value));
    if (!c) {
      this.report.warn(`Color "${String(r.value)}" isn't supported in Figma (sRGB only); dropped`, {
        nodeId: at.id,
        nodeName: at.name,
      });
      return { value: undefined };
    }
    return { value: c, token: r.token };
  }

  private solid(c: Resolved<Rgba>): PaintSpec[] {
    if (!c.value) return [];
    return [{ type: 'SOLID', color: c.value, ...(c.token ? { bind: c.token } : {}) }];
  }

  // ---------------------------------------------------------------- nodes

  convertFrame(frame: Frame, width: number): FrameSpec | null {
    this.bp = breakpointForWidth(width, this.ds.breakpoints);
    this.viewport = { width, height: frame.height === 'auto' ? 800 : frame.height };
    const root = this.doc.nodes[frame.rootNodeId];
    if (!root) return null;
    const fixedHeight = frame.height === 'auto' ? null : frame.height;
    const ctx: ParentCtx = {
      mode: 'VERTICAL',
      alignItems: 'stretch',
      width,
      height: fixedHeight,
      hug: { horizontal: false, vertical: fixedHeight === null },
    };
    let spec = this.node(root, ctx, {});
    if (spec && spec.kind !== 'FRAME') spec = this.wrapper(root, spec);
    if (!spec) return null;
    spec.name = frame.name;
    spec.absolute = null;
    spec.sizing = { horizontal: 'FIXED', vertical: fixedHeight === null ? 'HUG' : 'FIXED' };
    spec.width = width;
    spec.height = fixedHeight ?? spec.height;
    spec.hash = hashValue({ ...spec, children: undefined, hash: undefined });
    return spec;
  }

  /** A leaf as frame root: wrap it so the Figma top level is always a frame. */
  private wrapper(root: Node, inner: NodeSpec): FrameSpec {
    return {
      ...this.baseSpec(root, root.name ?? 'Frame'),
      cdId: `${root.id}:frame`,
      kind: 'FRAME',
      layout: {
        mode: 'VERTICAL',
        wrap: false,
        itemSpacing: 0,
        counterAxisSpacing: 0,
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
        primaryAlign: 'MIN',
        counterAlign: 'MIN',
      },
      fills: [],
      strokes: [],
      strokeWeights: { top: 0, right: 0, bottom: 0, left: 0 },
      dashed: false,
      radii: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 },
      clipsContent: false,
      children: [inner],
    };
  }

  private baseSpec(n: Node, name: string) {
    return {
      cdId: n.id,
      name: name.slice(0, 120),
      visible: true,
      opacity: 1,
      hash: '',
      absolute: null as { x: number; y: number } | null,
      sizing: { horizontal: 'HUG' as Sizing, vertical: 'HUG' as Sizing },
      width: 100,
      height: 100,
      rotation: 0,
      effects: [] as EffectSpec[],
      binds: {} as Partial<Record<BindableField, string>>,
    };
  }

  /** Convert one node (and its subtree). `defs` is the component definition in scope, if any. */
  private node(
    n: Node,
    parent: ParentCtx,
    inherited: Inherited,
    variantStyles?: Map<string, StyleProps>,
  ): NodeSpec | null {
    if (++this.count > MAX_SPEC_NODES) {
      if (this.count === MAX_SPEC_NODES + 1)
        this.report.error(`Push truncated at ${MAX_SPEC_NODES} nodes`);
      return null;
    }
    const s: StyleProps = {
      ...effectiveStyle(n.style, this.bp),
      ...(variantStyles?.get(n.id) ?? {}),
    };
    const at = { nodeId: n.id, nodeName: n.name };
    for (const key of Object.keys(s)) {
      if (UNSUPPORTED[key]) this.report.warn(UNSUPPORTED[key]!, { ...at, subject: key });
      else if (!HANDLED.has(key))
        this.report.info(`"${key}" is not pushed`, { ...at, subject: key });
    }
    const inh: Inherited = { ...inherited };
    for (const k of TYPO_PROPS) if (s[k] !== undefined) (inh as Record<string, unknown>)[k] = s[k];
    const fontSize = this.px(inh.fontSize ?? 16, n, 16).value ?? 16;

    const base = this.baseSpec(n, n.name ?? defaultName(n));
    base.visible = !(n.hidden || s.display === 'none');
    const op = this.resolve<number>(s.opacity, n);
    if (typeof op.value === 'number') base.opacity = op.value;
    if (op.token) base.binds.opacity = op.token;
    const rot = this.resolve<number>(s.rotate, n);
    if (typeof rot.value === 'number') base.rotation = -rot.value;
    base.effects = this.effects(s, n, fontSize);

    let spec: NodeSpec | null;
    switch (n.type) {
      case 'box':
        spec = this.box(n, s, base, parent, inh, fontSize);
        break;
      case 'text':
        spec = this.text(n, s, base, inh, fontSize);
        break;
      case 'image':
        spec = this.image(n, s, base, fontSize);
        break;
      case 'svg':
        spec = { ...base, kind: 'SVG', svg: n.props.svg } satisfies SvgSpec;
        break;
      case 'instance':
        spec = this.instance(n, base);
        break;
    }
    if (!spec) return null;
    this.sizing(n, s, spec, parent, fontSize);
    if (spec.kind === 'FRAME' && n.type === 'box')
      this.children(n, s, spec, parent, inh, variantStyles);
    if (n.type === 'box' && (n.props.href || n.tag === 'a'))
      this.report.info('Links are not pushed', { ...at, subject: 'href' });
    if (n.type === 'text' && n.props.href)
      this.report.info('Links are not pushed', { ...at, subject: 'href' });
    if (spec.kind !== 'FRAME') spec.hash = hashValue({ ...spec, hash: undefined });
    else spec.hash = hashValue({ ...spec, children: undefined, hash: undefined });
    return spec;
  }

  private effects(s: StyleProps, n: Node, fontSize: number): EffectSpec[] {
    const out: EffectSpec[] = [];
    const sh = this.resolve<string>(s.boxShadow, n);
    if (typeof sh.value === 'string') {
      const parsed = parseBoxShadow(sh.value, fontSize);
      if (parsed) out.push(...parsed);
      else
        this.report.warn('Shadow could not be parsed; dropped', { nodeId: n.id, nodeName: n.name });
    }
    const blur = this.px(s.blur, n, fontSize);
    if (blur.value) out.push({ type: 'LAYER_BLUR', radius: blur.value });
    return out;
  }

  private box(
    n: Extract<Node, { type: 'box' }>,
    s: StyleProps,
    base: ReturnType<Converter['baseSpec']>,
    parent: ParentCtx,
    inh: Inherited,
    fontSize: number,
  ): FrameSpec {
    const at = { nodeId: n.id, nodeName: n.name };
    const display = typeof s.display === 'string' ? s.display : 'block';
    const isFlex = display === 'flex' || display === 'inline-flex';
    const isGrid = display === 'grid';
    const dirRaw = typeof s.flexDirection === 'string' ? s.flexDirection : 'row';
    const mode: FrameSpec['layout']['mode'] = isFlex
      ? dirRaw.startsWith('column')
        ? 'VERTICAL'
        : 'HORIZONTAL'
      : isGrid
        ? 'HORIZONTAL'
        : display === 'inline'
          ? 'HORIZONTAL'
          : 'VERTICAL';
    if (isFlex && dirRaw.endsWith('reverse'))
      this.report.warn('Reversed flex direction pushed as reversed child order', {
        ...at,
        subject: 'flexDirection',
      });
    if (isGrid)
      this.report.warn('CSS grid approximated as a wrapping row', { ...at, subject: 'display' });
    const wrap =
      (isFlex && mode === 'HORIZONTAL' && s.flexWrap === 'wrap') || isGrid || display === 'inline';
    if (isFlex && s.flexWrap && s.flexWrap !== 'nowrap' && mode === 'VERTICAL')
      this.report.warn('Only horizontal auto-layout can wrap', { ...at, subject: 'flexWrap' });

    const gap = this.px(s.gap, n, fontSize);
    const rowGap = this.px(s.rowGap, n, fontSize);
    const colGap = this.px(s.columnGap, n, fontSize);
    const main =
      mode === 'HORIZONTAL'
        ? colGap.value !== undefined
          ? colGap
          : gap
        : rowGap.value !== undefined
          ? rowGap
          : gap;
    const cross = mode === 'HORIZONTAL' ? (rowGap.value !== undefined ? rowGap : gap) : colGap;
    const binds = base.binds;
    if (isFlex || isGrid) {
      if (main.token) binds.itemSpacing = main.token;
      if (wrap && cross.token) binds.counterAxisSpacing = cross.token;
    }

    const pad = (k: 'paddingTop' | 'paddingRight' | 'paddingBottom' | 'paddingLeft') => {
      const r = this.px(s[k], n, fontSize, parent.width);
      if (r.token) binds[k] = r.token;
      return r.value ?? 0;
    };
    const padding = {
      top: pad('paddingTop'),
      right: pad('paddingRight'),
      bottom: pad('paddingBottom'),
      left: pad('paddingLeft'),
    };

    const jc = isFlex ? String(s.justifyContent ?? 'flex-start') : 'flex-start';
    const primaryAlign: FrameSpec['layout']['primaryAlign'] =
      jc === 'center'
        ? 'CENTER'
        : jc === 'flex-end'
          ? 'MAX'
          : jc.startsWith('space')
            ? 'SPACE_BETWEEN'
            : 'MIN';
    if (jc === 'space-around' || jc === 'space-evenly')
      this.report.warn(`justify-content: ${jc} pushed as space-between`, {
        ...at,
        subject: 'justifyContent',
      });
    const ai = isFlex ? String(s.alignItems ?? 'stretch') : 'stretch';
    const counterAlign: FrameSpec['layout']['counterAlign'] =
      ai === 'center'
        ? 'CENTER'
        : ai === 'flex-end'
          ? 'MAX'
          : ai === 'baseline'
            ? 'BASELINE'
            : 'MIN';

    // fills: background color, then gradient on top (CSS paints background-image over color)
    const fills = this.solid(this.color(s.backgroundColor, n, inh.color));
    const bg = this.resolve<string>(s.backgroundImage, n);
    if (typeof bg.value === 'string' && bg.value !== 'none') {
      const g = parseGradient(bg.value);
      if (g) {
        fills.push(g);
        this.report.info('Gradient angle and stops are approximated', {
          ...at,
          subject: 'backgroundImage',
        });
      } else
        this.report.warn('Background gradient could not be parsed; dropped', {
          ...at,
          subject: 'backgroundImage',
        });
    }

    const { strokes, strokeWeights, dashed } = this.border(n, s, fontSize, inh, binds);
    const radii = this.radii(n, s, fontSize, binds);
    const overflow = String(s.overflow ?? 'visible');
    if (overflow === 'auto' || overflow === 'scroll')
      this.report.info('Scrolling containers are pushed as clipped frames', {
        ...at,
        subject: 'overflow',
      });

    const spec: FrameSpec = {
      ...base,
      kind: 'FRAME',
      layout: {
        mode,
        wrap,
        itemSpacing: isFlex || isGrid ? (main.value ?? 0) : 0,
        counterAxisSpacing: wrap ? (cross.value ?? 0) : 0,
        padding,
        primaryAlign,
        counterAlign,
      },
      fills,
      strokes,
      strokeWeights,
      dashed,
      radii,
      clipsContent: overflow !== 'visible',
      children: [],
    };

    return spec;
  }

  private children(
    n: Extract<Node, { type: 'box' }>,
    s: StyleProps,
    spec: FrameSpec,
    parent: ParentCtx,
    inh: Inherited,
    variantStyles?: Map<string, StyleProps>,
  ) {
    let kids = n.children
      .map((id) => this.doc.nodes[id] ?? this.componentNode(id))
      .filter((c): c is Node => !!c);
    if (kids.some((k) => effectiveStyle(k.style, this.bp).order !== undefined)) {
      kids = kids
        .map((k, i) => ({ k, i, o: Number(effectiveStyle(k.style, this.bp).order ?? 0) }))
        .sort((a, b) => a.o - b.o || a.i - b.i)
        .map((x) => x.k);
    }
    if (
      String(s.flexDirection ?? '').endsWith('reverse') &&
      String(s.display ?? '').includes('flex')
    )
      kids.reverse();
    const pad = spec.layout.padding;
    const inner = (
      sizing: Sizing,
      own: number,
      fromParent: number | null,
      padA: number,
      padB: number,
    ) =>
      sizing === 'FIXED'
        ? own - padA - padB
        : sizing === 'FILL' && fromParent !== null
          ? fromParent - padA - padB
          : null;
    const childCtx: ParentCtx = {
      mode: spec.layout.mode,
      alignItems: String(s.display ?? 'block').includes('flex')
        ? String(s.alignItems ?? 'stretch')
        : 'stretch',
      width: inner(spec.sizing.horizontal, spec.width, parent.width, pad.left, pad.right),
      height: inner(spec.sizing.vertical, spec.height, parent.height, pad.top, pad.bottom),
      hug: {
        horizontal: spec.sizing.horizontal === 'HUG',
        vertical: spec.sizing.vertical === 'HUG',
      },
    };
    for (const k of kids) {
      const c = this.node(k, childCtx, inh, variantStyles);
      if (c) spec.children.push(c);
    }
  }

  /** Component definition nodes are looked up through the active component (see instance()). */
  private activeComponent: ComponentDef | null = null;
  private componentNode(id: string): Node | undefined {
    return this.activeComponent?.nodes[id];
  }

  private border(
    n: Node,
    s: StyleProps,
    fontSize: number,
    inh: Inherited,
    binds: Partial<Record<BindableField, string>>,
  ) {
    const style = String(s.borderStyle ?? 'none');
    const all = this.px(s.borderWidth, n, fontSize);
    const side = (
      k: 'borderTopWidth' | 'borderRightWidth' | 'borderBottomWidth' | 'borderLeftWidth',
    ) => this.px(s[k], n, fontSize).value ?? all.value ?? 0;
    let strokeWeights = {
      top: side('borderTopWidth'),
      right: side('borderRightWidth'),
      bottom: side('borderBottomWidth'),
      left: side('borderLeftWidth'),
    };
    const any = Object.values(strokeWeights).some((w) => w > 0);
    if (style === 'none' || !any) {
      return {
        strokes: [] as PaintSpec[],
        strokeWeights: { top: 0, right: 0, bottom: 0, left: 0 },
        dashed: false,
      };
    }
    if (all.token) binds.strokeWeight = all.token;
    if (style === 'dotted')
      this.report.info('Dotted borders are pushed as dashed strokes', {
        nodeId: n.id,
        nodeName: n.name,
        subject: 'borderStyle',
      });
    const color = this.color(s.borderColor ?? 'currentColor', n, inh.color);
    strokeWeights = { ...strokeWeights };
    return { strokes: this.solid(color), strokeWeights, dashed: style !== 'solid' };
  }

  private radii(
    n: Node,
    s: StyleProps,
    fontSize: number,
    binds: Partial<Record<BindableField, string>>,
  ) {
    const all = this.px(s.borderRadius, n, fontSize);
    const corner = (
      k:
        | 'borderTopLeftRadius'
        | 'borderTopRightRadius'
        | 'borderBottomRightRadius'
        | 'borderBottomLeftRadius',
      field: 'topLeftRadius' | 'topRightRadius' | 'bottomRightRadius' | 'bottomLeftRadius',
    ) => {
      const r = this.px(s[k], n, fontSize);
      const tok = r.value !== undefined ? r.token : all.token;
      if (tok) binds[field] = tok;
      return r.value ?? all.value ?? 0;
    };
    return {
      topLeft: corner('borderTopLeftRadius', 'topLeftRadius'),
      topRight: corner('borderTopRightRadius', 'topRightRadius'),
      bottomRight: corner('borderBottomRightRadius', 'bottomRightRadius'),
      bottomLeft: corner('borderBottomLeftRadius', 'bottomLeftRadius'),
    };
  }

  private text(
    n: Extract<Node, { type: 'text' }>,
    s: StyleProps,
    base: ReturnType<Converter['baseSpec']>,
    inh: Inherited,
    fontSize: number,
  ): TextSpec {
    const at = { nodeId: n.id, nodeName: n.name };
    const binds = base.binds;
    const fam = this.resolve<string>(inh.fontFamily, n);
    if (fam.token) binds.fontFamily = fam.token;
    let family = typeof fam.value === 'string' ? primaryFamily(fam.value) : 'Inter';
    if (
      /^(ui-sans-serif|system-ui|sans-serif|-apple-system|ui-serif|serif|ui-monospace|monospace)$/i.test(
        family,
      )
    ) {
      this.report.info(`Generic font "${family}" pushed as Inter`, {
        ...at,
        subject: 'fontFamily',
      });
      family = /mono/i.test(family) ? 'Roboto Mono' : 'Inter';
      delete binds.fontFamily;
    }
    const fsz = this.px(inh.fontSize ?? 16, n, 16);
    if (fsz.token) binds.fontSize = fsz.token;
    const fw = this.resolve<number | string>(inh.fontWeight, n);
    if (fw.token) binds.fontWeight = fw.token;
    const weight = fw.value === 'bold' ? 700 : typeof fw.value === 'number' ? fw.value : 400;
    const italic = inh.fontStyle === 'italic';

    const lh = this.resolve<number | string>(inh.lineHeight, n);
    let lineHeight: TextSpec['lineHeight'] = { unit: 'AUTO' };
    if (typeof lh.value === 'number')
      lineHeight = { unit: 'PERCENT', value: roundPx(lh.value * 100) };
    else if (typeof lh.value === 'string' && lh.value !== 'normal') {
      const px = toPx(lh.value, { fontSize });
      if (px !== null) lineHeight = { unit: 'PIXELS', value: roundPx(px) };
    }
    const ls = this.resolve<number | string>(inh.letterSpacing, n);
    let letterSpacing: TextSpec['letterSpacing'] = { unit: 'PERCENT', value: 0 };
    if (typeof ls.value === 'string' && ls.value.endsWith('em') && !ls.value.endsWith('rem')) {
      letterSpacing = { unit: 'PERCENT', value: roundPx(parseFloat(ls.value) * 100) };
    } else if (ls.value !== undefined && ls.value !== 'normal') {
      const px = toPx(ls.value, { fontSize });
      if (px !== null) {
        letterSpacing = { unit: 'PIXELS', value: roundPx(px) };
        if (ls.token) binds.letterSpacing = ls.token;
      }
    }
    const ta = String(inh.textAlign ?? 'left');
    const tt = String(inh.textTransform ?? 'none');
    const td = String(inh.textDecoration ?? 'none');

    if (s.backgroundColor !== undefined || s.backgroundImage !== undefined)
      this.report.warn('Text layers have no background in Figma; wrap the text in a box', {
        ...at,
        subject: 'backgroundColor',
      });
    if (
      ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].some(
        (k) => s[k as keyof StyleProps] !== undefined,
      )
    )
      this.report.warn('Text layers have no padding in Figma', { ...at, subject: 'padding' });
    if (s.borderStyle !== undefined && s.borderStyle !== 'none')
      this.report.warn('Text layers have no border in Figma', { ...at, subject: 'borderStyle' });

    return {
      ...base,
      kind: 'TEXT',
      characters: n.props.text,
      font: { family, style: fontStyleName(weight, italic) },
      fontSize: fsz.value ?? 16,
      lineHeight,
      letterSpacing,
      textAlign:
        ta === 'center'
          ? 'CENTER'
          : ta === 'right'
            ? 'RIGHT'
            : ta === 'justify'
              ? 'JUSTIFIED'
              : 'LEFT',
      textCase:
        tt === 'uppercase'
          ? 'UPPER'
          : tt === 'lowercase'
            ? 'LOWER'
            : tt === 'capitalize'
              ? 'TITLE'
              : 'ORIGINAL',
      textDecoration:
        td === 'underline' ? 'UNDERLINE' : td === 'line-through' ? 'STRIKETHROUGH' : 'NONE',
      autoResize: 'HEIGHT',
      fills: this.solid(this.color(inh.color ?? '#000000', n)),
    };
  }

  private image(
    n: Extract<Node, { type: 'image' }>,
    s: StyleProps,
    base: ReturnType<Converter['baseSpec']>,
    fontSize: number,
  ): ImageSpec {
    const fit = String(s.objectFit ?? 'fill');
    const scaleMode = fit === 'contain' || fit === 'scale-down' || fit === 'none' ? 'FIT' : 'FILL';
    if (fit === 'fill')
      this.report.info('object-fit: fill (stretch) pushed as Fill (crop)', {
        nodeId: n.id,
        nodeName: n.name,
        subject: 'objectFit',
      });
    return {
      ...base,
      kind: 'IMAGE',
      fills: [{ type: 'IMAGE', src: n.props.src, scaleMode }],
      radii: this.radii(n, s, fontSize, base.binds),
    };
  }

  private instance(n: InstanceNode, base: ReturnType<Converter['baseSpec']>): InstanceSpec | null {
    const def = this.ds.components[n.componentRef.componentId];
    if (!def) {
      this.report.error(
        `Component "${n.componentRef.componentId}" is not in the design system; skipped`,
        {
          nodeId: n.id,
          nodeName: n.name,
        },
      );
      return null;
    }
    const variant: Record<string, string> = {};
    for (const [axis, v] of Object.entries(def.variants))
      variant[axis] = n.componentRef.variant[axis] ?? v.default;
    const key = componentKey(def.id, variant);
    if (!this.components.has(key)) this.buildComponent(def, variant, key);

    const textOverrides: Record<string, string> = {};
    const hidden: string[] = [];
    for (const dn of Object.values(def.nodes)) {
      const b = dn.bind;
      if (!b) continue;
      if (b.text && dn.type === 'text') {
        const v = n.props.values[b.text];
        if (typeof v === 'string' && v !== dn.props.text) textOverrides[dn.id] = v;
      }
      if (b.hidden) {
        const v = n.props.values[b.hidden];
        if (v === true) hidden.push(dn.id);
      }
      if (b.src && n.props.values[b.src] !== undefined)
        this.report.info('Image prop overrides on instances are not pushed', {
          nodeId: n.id,
          nodeName: n.name,
          subject: b.src,
        });
    }
    return {
      ...base,
      name: n.name ?? def.name,
      kind: 'INSTANCE',
      componentKey: key,
      textOverrides,
      hidden,
    };
  }

  private buildComponent(def: ComponentDef, variant: Record<string, string>, key: string) {
    const root = def.nodes[def.rootNodeId];
    if (!root) return;
    const vs = new Map<string, StyleProps>();
    for (const rule of def.variantStyles) {
      if (!Object.entries(rule.when).every(([k, v]) => variant[k] === v)) continue;
      vs.set(rule.nodeId, {
        ...(vs.get(rule.nodeId) ?? {}),
        ...effectiveStyle(rule.style, this.bp),
      });
    }
    const prev = this.activeComponent;
    this.activeComponent = def;
    const ctx: ParentCtx = {
      mode: 'NONE',
      alignItems: 'flex-start',
      width: null,
      height: null,
      hug: { horizontal: true, vertical: true },
    };
    const spec = this.node(root, ctx, {}, vs);
    this.activeComponent = prev;
    if (!spec || spec.kind === 'INSTANCE') {
      this.report.error(`Component "${def.id}" could not be converted`, { subject: def.id });
      return;
    }
    spec.absolute = null;
    const suffix = Object.entries(variant)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    this.components.set(key, {
      key,
      componentId: def.id,
      variant,
      name: suffix ? `${def.name} / ${suffix}` : def.name,
      root: spec,
    });
  }

  // ---------------------------------------------------------------- sizing

  private sizing(n: Node, s: StyleProps, spec: NodeSpec, parent: ParentCtx, fontSize: number) {
    const abs = n.positioning === 'absolute';
    const grow = typeof s.flexGrow === 'number' && s.flexGrow > 0;
    const alignSelf = String(s.alignSelf ?? 'auto');
    const stretch =
      alignSelf === 'stretch' || (alignSelf === 'auto' && parent.alignItems === 'stretch');

    const axis = (dim: 'width' | 'height'): Sizing => {
      const v = this.resolve(s[dim], n).value;
      const horizontal = dim === 'width';
      const parentMain = parent.mode === 'HORIZONTAL' ? 'width' : 'height';
      const parentHug = horizontal ? parent.hug.horizontal : parent.hug.vertical;
      const canFill = parent.mode !== 'NONE' && !abs && !parentHug;
      if (v === 'fill' || (typeof v === 'string' && v.trim() === '100%')) {
        if (canFill) return 'FILL';
        if (parent.mode === 'NONE' || abs) {
          const known = horizontal ? parent.width : parent.height;
          if (known !== null) return 'FIXED';
        }
        return 'HUG';
      }
      if (v === 'hug') return 'HUG';
      if (v !== undefined && v !== 'auto') return 'FIXED';
      // auto
      if (abs || parent.mode === 'NONE') return 'HUG';
      if (grow && parentMain === dim && canFill) return 'FILL';
      if (parentMain !== dim && stretch && canFill) {
        // CSS stretches block-level children across the parent's cross axis.
        if (horizontal && n.type === 'box') {
          const display = String(s.display ?? 'block');
          if (display.startsWith('inline')) return 'HUG';
        }
        return 'FILL';
      }
      return 'HUG';
    };
    let horizontal = axis('width');
    let vertical = axis('height');
    if (spec.kind === 'SVG' || spec.kind === 'IMAGE') {
      if (horizontal === 'HUG') horizontal = 'FIXED';
      if (vertical === 'HUG') vertical = 'FIXED';
    }
    spec.sizing = { horizontal, vertical };

    const w = this.px(s.width, n, fontSize, parent.width);
    const h = this.px(s.height, n, fontSize, parent.height);
    if (w.token && horizontal === 'FIXED') spec.binds.width = w.token;
    if (h.token && vertical === 'FIXED') spec.binds.height = h.token;
    const intrinsic = spec.kind === 'SVG' ? svgSize(spec.svg) : null;
    spec.width =
      w.value ??
      (horizontal === 'FIXED' && parent.width !== null
        ? parent.width
        : (intrinsic?.width ?? parent.width ?? 100));
    const ar =
      typeof s.aspectRatio === 'number'
        ? s.aspectRatio
        : typeof s.aspectRatio === 'string' && s.aspectRatio !== 'auto'
          ? ratio(s.aspectRatio)
          : null;
    spec.height =
      h.value ??
      (ar
        ? roundPx(spec.width / ar)
        : (intrinsic?.height ?? (horizontal === 'FIXED' ? spec.width : 100)));
    if (spec.kind === 'IMAGE' && h.value === undefined && !ar)
      this.report.warn(
        'Image height is unknown without an explicit height or aspect ratio; pushed square',
        {
          nodeId: n.id,
          nodeName: n.name,
          subject: 'height',
        },
      );
    if (s.aspectRatio !== undefined && spec.kind !== 'IMAGE' && spec.kind !== 'SVG')
      this.report.info('Aspect ratio is applied once, not kept as a constraint', {
        nodeId: n.id,
        nodeName: n.name,
        subject: 'aspectRatio',
      });

    for (const k of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const) {
      const r = this.px(
        s[k] === 'none' || s[k] === 'auto' ? undefined : s[k],
        n,
        fontSize,
        k.endsWith('Width') ? parent.width : parent.height,
      );
      if (r.value !== undefined) {
        spec[k] = r.value;
        if (r.token) spec.binds[k] = r.token;
      }
    }

    if (spec.kind === 'TEXT') {
      const nowrap = s.whiteSpace === 'nowrap';
      spec.autoResize =
        horizontal === 'HUG' || nowrap
          ? 'WIDTH_AND_HEIGHT'
          : vertical === 'FIXED'
            ? 'NONE'
            : 'HEIGHT';
    }

    if (abs) {
      const left = this.px(s.left, n, fontSize, parent.width).value;
      const top = this.px(s.top, n, fontSize, parent.height).value;
      const right = this.px(s.right, n, fontSize, parent.width).value;
      const bottom = this.px(s.bottom, n, fontSize, parent.height).value;
      let x = left ?? 0;
      let y = top ?? 0;
      if (left === undefined && right !== undefined) {
        if (parent.width !== null) x = parent.width - right - spec.width;
        else
          this.report.warn('right offset needs a fixed-width parent; placed at left 0', {
            nodeId: n.id,
            nodeName: n.name,
            subject: 'right',
          });
      }
      if (top === undefined && bottom !== undefined) {
        if (parent.height !== null) y = parent.height - bottom - spec.height;
        else
          this.report.warn('bottom offset needs a fixed-height parent; placed at top 0', {
            nodeId: n.id,
            nodeName: n.name,
            subject: 'bottom',
          });
      }
      spec.absolute = { x: roundPx(x), y: roundPx(y) };
      if (s.zIndex !== undefined)
        this.report.info('z-index is not pushed; layer order follows the tree', {
          nodeId: n.id,
          nodeName: n.name,
          subject: 'zIndex',
        });
    }
  }
}

function defaultName(n: Node): string {
  switch (n.type) {
    case 'text':
      return n.props.text.slice(0, 40) || 'Text';
    case 'box':
      return n.tag;
    case 'image':
      return n.props.alt || 'Image';
    case 'svg':
      return 'Vector';
    case 'instance':
      return n.componentRef.componentId;
  }
}

function ratio(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(s);
  return m ? parseFloat(m[1]!) / parseFloat(m[2]!) : null;
}

function svgSize(svg: string): { width: number; height: number } | null {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const w = /\swidth\s*=\s*["']?(\d+(?:\.\d+)?)(?:px)?["'\s>]/i.exec(tag);
  const h = /\sheight\s*=\s*["']?(\d+(?:\.\d+)?)(?:px)?["'\s>]/i.exec(tag);
  if (w && h) return { width: parseFloat(w[1]!), height: parseFloat(h[1]!) };
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(
    tag,
  );
  if (vb) return { width: parseFloat(vb[1]!), height: parseFloat(vb[2]!) };
  return null;
}

const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin',
  200: 'Extra Light',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'Semi Bold',
  700: 'Bold',
  800: 'Extra Bold',
  900: 'Black',
};

/** Figma font style name for a CSS weight (Inter's naming, which most families follow). */
export function fontStyleName(weight: number, italic: boolean): string {
  const w = WEIGHT_NAMES[Math.min(900, Math.max(100, Math.round(weight / 100) * 100))]!;
  if (!italic) return w;
  return w === 'Regular' ? 'Italic' : `${w} Italic`;
}

export function componentKey(componentId: string, variant: Record<string, string>): string {
  const q = Object.keys(variant)
    .sort()
    .map((k) => `${k}=${variant[k]}`)
    .join('&');
  return q ? `${componentId}?${q}` : componentId;
}

/** Build the push plan for a document. */
export function docToFigmaPlan(
  doc: DesignDoc,
  ds: DesignSystemSpec,
  opts: DocToFigmaOptions,
): PushPlan {
  const bindVariables = opts.variables !== false;
  const conv = new Converter(doc, ds, bindVariables);
  const wanted = opts.frameIds ? new Set(opts.frameIds) : null;
  const frames: PushPlan['frames'] = [];
  for (const f of doc.frames) {
    if (wanted && !wanted.has(f.id)) continue;
    const width = Math.round(opts.width ?? f.width);
    const root = conv.convertFrame(f, width);
    if (!root) continue;
    frames.push({
      frameId: f.id,
      name: f.name,
      width,
      breakpoint: breakpointForWidth(width, ds.breakpoints),
      canvas: f.canvas,
      root,
    });
  }
  if (wanted) {
    for (const id of wanted)
      if (!doc.frames.some((f) => f.id === id))
        conv.report.error('Frame not found', { subject: id });
  }
  const variables = bindVariables ? tokensToVariables(ds, { report: conv.report }) : null;
  return {
    version: 1,
    projectId: opts.projectId,
    docVersion: opts.docVersion,
    frames,
    components: [...conv.components.values()],
    variables,
    report: conv.report.list(),
  };
}
