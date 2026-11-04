/**
 * Deterministic design-system linter (Story 4.6). Implements the LintDoc contract from
 * @crunch/contracts: same doc + design system → same issues, in document order, with no I/O and
 * no model calls. It runs on every local edit and in the agent's self-correction loop, so it is
 * a single pass over the doc with per-run caches (see the 5,000-node benchmark test).
 *
 * Rules:
 *   unknown-token            token references (styles, overrides, sliders) the system doesn't define
 *   literal-should-be-token  a literal equal to (or, for key props, close to) a token value
 *   off-scale-spacing        padding/margin/gap literals that aren't on the spacing scale
 *   contrast                 text below WCAG AA (4.5:1, or 3:1 for large text)
 *   missing-alt              images without alt text (and unlabeled SVGs)
 *   missing-component        instances of unknown components or variant options
 *   font-not-in-system       font families the system doesn't define
 * Fixes are DocOps (setStyle → token) and only offered when the replacement is unambiguous.
 */
import type { LintDoc, LintIssue, LintOptions } from '@crunch/contracts';
import {
  BREAKPOINTS,
  isTokenRef,
  resolveAt,
  STYLE_PROP_NAMES,
  STYLE_PROPS,
  type Breakpoint,
  type DesignDoc,
  type DesignSystemSpec,
  type DocOp,
  type Node,
  type ResponsiveStyle,
  type StylePropName,
  type TokenKind,
} from '@crunch/doc-model';
import { contrast, hex, over, parseColor, type Rgba } from './color';
import {
  lengthPx,
  primaryFamily,
  REM_PX,
  TokenIndex,
  weightNum,
  type IndexedToken,
} from './tokens';

export type { LintIssue, LintOptions, LintDoc } from '@crunch/contracts';
export { TokenIndex } from './tokens';
export { contrast, parseColor } from './color';

/** WCAG 2.x AA thresholds. */
export const AA_NORMAL = 4.5;
export const AA_LARGE = 3;
/** Max CIEDE2000 distance for auto-fixing a color literal to the nearest token. */
export const COLOR_FIX_DISTANCE = 5;

const SPACING: ReadonlySet<string> = new Set([
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'gap',
  'rowGap',
  'columnGap',
]);

/** Props where any off-system literal is flagged (not only exact token matches). */
const KEY_PROPS: ReadonlySet<string> = new Set([
  'color',
  'backgroundColor',
  'borderColor',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'borderRadius',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomRightRadius',
  'borderBottomLeftRadius',
  'boxShadow',
]);

const KEYWORDS: ReadonlySet<unknown> = new Set([
  'auto',
  'hug',
  'fill',
  'none',
  'normal',
  'transparent',
  'currentColor',
  'inherit',
]);

const fmt = (v: unknown) => (typeof v === 'string' ? `"${v}"` : String(v));

function setTokenFix(id: string, breakpoint: Breakpoint, prop: string, path: string): DocOp[] {
  return [{ op: 'setStyle', id, breakpoint, prop, value: { token: path } }];
}

interface Ctx {
  doc: DesignDoc;
  ds: DesignSystemSpec;
  index: TokenIndex;
  out: LintIssue[];
  only: Set<string> | null;
}

// ---------------------------------------------------------------------------------------------
// per-node style rules
// ---------------------------------------------------------------------------------------------

function nearestFix(
  ctx: Ctx,
  kinds: readonly TokenKind[],
  prop: string,
  value: unknown,
): IndexedToken | undefined {
  const { index } = ctx;
  if (kinds.includes('color')) {
    const c = typeof value === 'string' ? parseColor(value) : null;
    if (!c || c.a === 0) return undefined;
    const n = index.nearestColor(c);
    return n && n.distance <= COLOR_FIX_DISTANCE ? n.token : undefined;
  }
  if (prop === 'fontWeight') {
    const w = weightNum(value);
    const n = w === undefined ? undefined : index.nearestNumeric('fontWeight', w, 'num');
    return n && n.diff <= 100 ? n.token : undefined;
  }
  if (prop === 'lineHeight' && typeof value === 'number') {
    const n = index.nearestNumeric('lineHeight', value, 'num');
    return n && n.diff <= 0.1 ? n.token : undefined;
  }
  const px = lengthPx(value);
  if (px === undefined) return undefined;
  let best: { token: IndexedToken; diff: number } | undefined;
  for (const k of kinds) {
    const n = index.nearestNumeric(k, px, 'px');
    if (n && (!best || n.diff < best.diff)) best = n;
  }
  return best && best.diff <= Math.max(2, px * 0.125) ? best.token : undefined;
}

function checkStyleValue(ctx: Ctx, node: Node, bp: Breakpoint, prop: string, value: unknown): void {
  const { index, out } = ctx;
  const def = (STYLE_PROPS as Record<string, { tokens?: readonly TokenKind[]; label: string }>)[
    prop
  ];
  const label = def?.label ?? prop;
  const at = { nodeId: node.id, prop, breakpoint: bp };

  if (isTokenRef(value)) {
    if (!index.has(value.token))
      out.push({
        code: 'unknown-token',
        severity: 'error',
        message: `${label} uses unknown token "${value.token}"`,
        ...at,
      });
    else if (index.resolve(value.token) === null)
      out.push({
        code: 'unknown-token',
        severity: 'error',
        message: `${label} uses token "${value.token}", which can't be resolved`,
        ...at,
      });
    return;
  }

  const kinds = def?.tokens;
  if (!kinds || KEYWORDS.has(value)) return;

  if (prop === 'fontFamily') {
    if (typeof value !== 'string' || !index.hasKind('fontFamily')) return;
    const exact = index.exactMatch(kinds, value);
    if (exact) {
      out.push({
        code: 'literal-should-be-token',
        severity: 'warning',
        message: `Font ${fmt(value)} should use token ${exact.path}`,
        ...at,
        fix: setTokenFix(node.id, bp, prop, exact.path),
      });
      return;
    }
    const family = primaryFamily(value);
    const same = (index.byKind.get('fontFamily') ?? []).find(
      (t) => typeof t.value === 'string' && primaryFamily(t.value) === family,
    );
    out.push({
      code: 'font-not-in-system',
      severity: 'warning',
      message: same
        ? `Font ${fmt(value)} isn't a design-system font stack; use ${same.path}`
        : `Font "${family}" isn't in the design system`,
      ...at,
      ...(same ? { fix: setTokenFix(node.id, bp, prop, same.path) } : {}),
    });
    return;
  }

  if (SPACING.has(prop)) {
    if (!index.hasKind('dimension')) return;
    const px = lengthPx(value);
    if (px === undefined || px === 0) return;
    const exact = index.exactMatch(['dimension'], value);
    if (exact) {
      out.push({
        code: 'literal-should-be-token',
        severity: 'warning',
        message: `${label} ${fmt(value)} should use spacing token ${exact.path}`,
        ...at,
        fix: setTokenFix(node.id, bp, prop, exact.path),
      });
      return;
    }
    if (px < 0 && index.exactMatch(['dimension'], -px)) return; // negative margin on the scale
    const n = px > 0 ? index.nearestNumeric('dimension', px, 'px') : undefined;
    out.push({
      code: 'off-scale-spacing',
      severity: 'warning',
      message: `${label} ${fmt(value)} is off the spacing scale${n ? `; nearest is ${n.token.path} (${n.token.value})` : ''}`,
      ...at,
      ...(n ? { fix: setTokenFix(node.id, bp, prop, n.token.path) } : {}),
    });
    return;
  }

  if (value === 0 && !kinds.includes('color')) return;
  const exact = index.exactMatch(kinds, value);
  if (exact) {
    out.push({
      code: 'literal-should-be-token',
      severity: KEY_PROPS.has(prop) ? 'warning' : 'info',
      message: `${label} ${fmt(value)} should use token ${exact.path}`,
      ...at,
      fix: setTokenFix(node.id, bp, prop, exact.path),
    });
    return;
  }
  if (!KEY_PROPS.has(prop) || !kinds.some((k) => index.hasKind(k))) return;
  const near = nearestFix(ctx, kinds, prop, value);
  out.push({
    code: 'literal-should-be-token',
    severity: 'warning',
    message: `${label} ${fmt(value)} isn't a design-system value${near ? `; closest is ${near.path} (${near.value})` : ''}`,
    ...at,
    ...(near ? { fix: setTokenFix(node.id, bp, prop, near.path) } : {}),
  });
}

function checkNode(ctx: Ctx, node: Node): void {
  const { out, ds } = ctx;
  for (const bp of BREAKPOINTS) {
    const style = node.style[bp];
    if (!style) continue;
    // Registry order (not object key order), so output is stable however the doc was built.
    for (const prop of STYLE_PROP_NAMES) {
      const value = style[prop];
      if (value !== undefined) checkStyleValue(ctx, node, bp, prop, value);
    }
  }

  if (node.type === 'image') {
    if (!node.props.alt.trim() && node.props.role !== 'presentation')
      out.push({
        code: 'missing-alt',
        severity: 'warning',
        message:
          'Image has no alt text (describe it, or mark it decorative with role="presentation")',
        nodeId: node.id,
        prop: 'alt',
      });
  } else if (node.type === 'svg') {
    if (!node.props.ariaLabel?.trim() && node.props.role !== 'presentation')
      out.push({
        code: 'missing-alt',
        severity: 'info',
        message:
          'SVG has no accessible label (set ariaLabel, or role="presentation" if decorative)',
        nodeId: node.id,
        prop: 'ariaLabel',
      });
  } else if (node.type === 'instance') {
    const { componentId, variant } = node.componentRef;
    const comp = ds.components[componentId];
    if (!comp) {
      out.push({
        code: 'missing-component',
        severity: 'error',
        message: `Component "${componentId}" isn't in the design system`,
        nodeId: node.id,
      });
      return;
    }
    for (const [axis, option] of Object.entries(variant)) {
      const v = comp.variants[axis];
      if (!v || !v.options.includes(option))
        out.push({
          code: 'missing-component',
          severity: 'warning',
          message: v
            ? `${comp.name} has no "${option}" ${axis} (options: ${v.options.join(', ')})`
            : `${comp.name} has no "${axis}" variant`,
          nodeId: node.id,
        });
    }
    for (const prop of Object.keys(node.props.values)) {
      if (!comp.props[prop])
        out.push({
          code: 'missing-component',
          severity: 'info',
          message: `${comp.name} has no "${prop}" prop`,
          nodeId: node.id,
        });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// contrast
// ---------------------------------------------------------------------------------------------

interface Inherited {
  /** null = unknown background (gradient), skip contrast. */
  bg: Rgba | null;
  fg: Rgba;
  fontPx: number;
  weight: number;
}

function resolveColor(ctx: Ctx, v: unknown): Rgba | null | undefined {
  if (v === undefined) return undefined;
  const lit = isTokenRef(v) ? ctx.index.resolve(v.token) : v;
  if (typeof lit !== 'string') return null;
  return parseColor(lit);
}

function fontPxOf(ctx: Ctx, v: unknown, parent: number): number {
  const lit = isTokenRef(v) ? ctx.index.resolve(v.token) : v;
  if (typeof lit === 'number') return lit;
  if (typeof lit !== 'string') return parent;
  const m = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|%)$/.exec(lit.trim());
  if (!m) return parent;
  const n = Number(m[1]);
  return m[2] === 'px'
    ? n
    : m[2] === 'rem'
      ? n * REM_PX
      : m[2] === 'em'
        ? n * parent
        : (n / 100) * parent;
}

function contrastFix(ctx: Ctx, node: Node, bp: Breakpoint, fg: Rgba, bg: Rgba, min: number) {
  // Closest color token (to the current text color) that passes on this background.
  let best: { path: string; d: number } | undefined;
  for (const t of ctx.index.byKind.get('color') ?? []) {
    if (!t.color || t.color.a !== 1 || contrast(t.color, bg) < min) continue;
    const d = Math.abs(t.color.r - fg.r) + Math.abs(t.color.g - fg.g) + Math.abs(t.color.b - fg.b);
    if (!best || d < best.d) best = { path: t.path, d };
  }
  if (!best) return undefined;
  const own = resolveAt(node.style, 'color', bp);
  return setTokenFix(node.id, own.from ?? bp, 'color', best.path);
}

const PROPS_FOR_CONTRAST: StylePropName[] = [
  'color',
  'backgroundColor',
  'backgroundImage',
  'fontSize',
  'fontWeight',
  'display',
];

/**
 * What contrast walks: a doc node, or a part of an expanded component instance. The expansion
 * mirrors @crunch/renderer's expandInstance (variant styles merged, the instance's style on the
 * root, text/hidden bindings applied, nested instances expanded), kept local so ds-lint stays a
 * leaf package.
 */
interface Item {
  node: Node;
  style: ResponsiveStyle;
  hidden: boolean;
  /** Doc node the issue is reported on (the instance, for its parts). */
  docId: string;
  /** Unique per rendered element. */
  key: string;
  /** "Button › Label" for instance parts. */
  part?: string;
  kids: () => Item[];
}

const MAX_INSTANCE_DEPTH = 8;

function mergeStyle(a: ResponsiveStyle, b: ResponsiveStyle): ResponsiveStyle {
  return {
    base: { ...a.base, ...b.base },
    md: a.md || b.md ? { ...a.md, ...b.md } : undefined,
    lg: a.lg || b.lg ? { ...a.lg, ...b.lg } : undefined,
  };
}

function docItem(doc: DesignDoc, ds: DesignSystemSpec, node: Node): Item {
  if (node.type === 'instance') return instanceItem(ds, node, node.style, node.id, node.id, [], 0);
  return {
    node,
    style: node.style,
    hidden: !!node.hidden,
    docId: node.id,
    key: node.id,
    kids: () =>
      node.children.flatMap((c) => {
        const n = doc.nodes[c];
        return n ? [docItem(doc, ds, n)] : [];
      }),
  };
}

function instanceItem(
  ds: DesignSystemSpec,
  inst: Extract<Node, { type: 'instance' }>,
  instStyle: ResponsiveStyle,
  docId: string,
  key: string,
  trail: string[],
  depth: number,
): Item {
  const comp = ds.components[inst.componentRef.componentId];
  // Missing components are reported by checkNode; nothing to measure here.
  if (!comp || depth > MAX_INSTANCE_DEPTH)
    return { node: inst, style: instStyle, hidden: true, docId, key, kids: () => [] };
  const variant: Record<string, string> = {};
  for (const [axis, v] of Object.entries(comp.variants))
    variant[axis] = inst.componentRef.variant[axis] ?? v.default;
  const propValue = (name: string) => inst.props.values[name] ?? comp.props[name]?.default;
  const names = [...trail, comp.name];

  const build = (partId: string, isRoot: boolean): Item => {
    const part = comp.nodes[partId]!;
    let style = part.style;
    for (const vs of comp.variantStyles)
      if (vs.nodeId === partId && Object.entries(vs.when).every(([k, v]) => variant[k] === v))
        style = mergeStyle(style, vs.style);
    if (isRoot) style = mergeStyle(style, instStyle);
    let node: Node = part;
    if (part.type === 'text' && part.bind?.text) {
      const v = propValue(part.bind.text);
      if (v !== undefined) node = { ...part, props: { ...part.props, text: String(v) } };
    }
    const hidden =
      (part.bind?.hidden ? propValue(part.bind.hidden) === false : false) ||
      !!part.hidden ||
      (isRoot && !!inst.hidden);
    const partKey = `${key}-${partId}`;
    if (node.type === 'instance') {
      const nested = instanceItem(ds, node, style, docId, partKey, names, depth + 1);
      return { ...nested, hidden: nested.hidden || hidden };
    }
    return {
      node,
      style,
      hidden,
      docId,
      key: partKey,
      part: `${names.join(' › ')} › ${part.name ?? partId}`,
      kids: () => part.children.map((c) => build(c, false)),
    };
  };
  return build(comp.rootNodeId, true);
}

function contrastPass(
  ctx: Ctx,
  bp: Breakpoint,
  root: Node,
  base: Inherited,
  seen: Map<string, string>,
) {
  const { out } = ctx;
  const stack: [Item, Inherited][] = [[docItem(ctx.doc, ctx.ds, root), base]];
  while (stack.length) {
    const [item, inh] = stack.pop()!;
    const { node } = item;
    if (item.hidden) continue;
    const at = (p: StylePropName) => resolveAt(item.style, p, bp).value;
    if (at('display') === 'none') continue;

    const next: Inherited = { ...inh };
    const bgImage = at('backgroundImage');
    const bgColor = resolveColor(ctx, at('backgroundColor'));
    if (bgColor && bgColor.a > 0 && next.bg)
      next.bg = bgColor.a >= 1 ? bgColor : over(bgColor, next.bg);
    else if (bgColor && bgColor.a >= 1) next.bg = bgColor;
    if (bgImage !== undefined && bgImage !== 'none') next.bg = null;
    const fg = resolveColor(ctx, at('color'));
    if (fg) next.fg = fg;
    const fs = at('fontSize');
    if (fs !== undefined) next.fontPx = fontPxOf(ctx, fs, inh.fontPx);
    const fw = at('fontWeight');
    if (fw !== undefined) {
      const w = isTokenRef(fw) ? weightNum(ctx.index.resolve(fw.token)) : weightNum(fw);
      if (w !== undefined) next.weight = w;
    }

    if (node.type === 'text' && node.props.text.trim() && next.bg && next.fg.a > 0) {
      if (!ctx.only || ctx.only.has(item.docId)) {
        const color = next.fg.a >= 1 ? next.fg : over(next.fg, next.bg);
        const ratio = contrast(color, next.bg);
        const large = next.fontPx >= 24 || (next.fontPx >= 18.66 && next.weight >= 700);
        const min = large ? AA_LARGE : AA_NORMAL;
        if (ratio < min) {
          const key = `${hex(color)}|${hex(next.bg)}|${min}`;
          // md/lg passes only report what differs from base.
          if (seen.get(item.key) !== key) {
            seen.set(item.key, key);
            // Instance parts live in the design system, so there's no doc-level fix for them.
            const fix = item.part ? undefined : contrastFix(ctx, node, bp, color, next.bg, min);
            out.push({
              code: 'contrast',
              severity: 'error',
              message: `${item.part ? `${item.part}: t` : 'T'}ext contrast ${ratio.toFixed(2)}:1 is below WCAG AA ${min}:1 (${hex(color)} on ${hex(next.bg)}${large ? ', large text' : ''})`,
              nodeId: item.docId,
              prop: 'color',
              breakpoint: bp,
              ...(fix ? { fix } : {}),
            });
          }
        }
      }
    }
    const kids = item.kids();
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i]!, next]);
  }
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

export const lintDoc: LintDoc = (
  doc: DesignDoc,
  ds: DesignSystemSpec,
  opts: LintOptions = {},
): LintIssue[] => {
  const index = new TokenIndex(ds, doc, opts.theme);
  const ctx: Ctx = {
    doc,
    ds,
    index,
    out: [],
    only: opts.nodeIds ? new Set(opts.nodeIds) : null,
  };

  // 1. Per-node rules, in document order (frames, then pre-order).
  let responsive = false;
  for (const f of doc.frames) {
    const stack = [f.rootNodeId];
    while (stack.length) {
      const n = doc.nodes[stack.pop()!];
      if (!n) continue;
      if (!responsive && (n.style.md || n.style.lg))
        responsive = PROPS_FOR_CONTRAST.some(
          (p) => n.style.md?.[p] !== undefined || n.style.lg?.[p] !== undefined,
        );
      if (!ctx.only || ctx.only.has(n.id)) checkNode(ctx, n);
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
    }
  }

  // 2. Contrast, per frame; md/lg only when something changes at those breakpoints.
  const defaultFg = parseColor(String(index.resolve('color.text') ?? '#000000')) ?? {
    r: 0,
    g: 0,
    b: 0,
    a: 1,
  };
  const bgLit = index.resolve('color.background');
  const defaultBg = (typeof bgLit === 'string' && parseColor(bgLit)) || { r: 1, g: 1, b: 1, a: 1 };
  const base: Inherited = {
    bg: defaultBg.a >= 1 ? defaultBg : over(defaultBg, { r: 1, g: 1, b: 1, a: 1 }),
    fg: defaultFg,
    fontPx: REM_PX,
    weight: 400,
  };
  const contrastIssues: LintIssue[] = [];
  const main = ctx.out;
  ctx.out = contrastIssues;
  const seen = new Map<string, string>();
  for (const bp of responsive ? BREAKPOINTS : (['base'] as const)) {
    for (const f of doc.frames) {
      const root = doc.nodes[f.rootNodeId];
      if (root) contrastPass(ctx, bp, root, base, seen);
    }
  }
  ctx.out = main;
  // Keep document order: merge contrast issues after each node's own issues.
  const order = new Map<string, number>();
  let i = 0;
  for (const f of doc.frames) {
    const stack = [f.rootNodeId];
    while (stack.length) {
      const id = stack.pop()!;
      const n = doc.nodes[id];
      if (!n) continue;
      order.set(id, i++);
      for (let k = n.children.length - 1; k >= 0; k--) stack.push(n.children[k]!);
    }
  }
  const all = [...main, ...contrastIssues]
    .map((issue, seq) => ({
      issue,
      seq,
      pos: order.get(issue.nodeId ?? '') ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.pos - b.pos || a.seq - b.seq)
    .map((x) => x.issue);

  // 3. Doc-level references (only on full runs).
  if (!ctx.only) {
    for (const p of Object.keys(doc.tokenOverrides).sort()) {
      if (!index.has(p))
        all.push({
          code: 'unknown-token',
          severity: 'warning',
          message: `Token override for unknown token "${p}" is ignored`,
        });
    }
    for (const s of doc.sliders) {
      for (const b of s.bindings) {
        if ('token' in b.target && !index.has(b.target.token))
          all.push({
            code: 'unknown-token',
            severity: 'warning',
            message: `Slider "${s.label}" controls unknown token "${b.target.token}"`,
          });
      }
    }
  }
  return all;
};
