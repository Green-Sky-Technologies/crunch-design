/**
 * Inspector model (Story 3.3): grouping of every allowlisted StyleProp, input parsing and
 * validation, keyword options, token filtering and breakpoint provenance. UI-free.
 */
import {
  isTokenRef,
  resolveAt,
  resolveToken,
  STYLE_PROP_NAMES,
  STYLE_PROPS,
  validateStyleValue,
  type Breakpoint,
  type DesignSystemSpec,
  type ResponsiveStyle,
  type StyleGroup,
  type StylePropName,
  type TokenType,
} from '@crunch/doc-model';

export const GROUP_LABELS: Record<StyleGroup, string> = {
  layout: 'Layout',
  flexChild: 'Flex child',
  grid: 'Grid',
  size: 'Size',
  spacing: 'Spacing',
  position: 'Position',
  typography: 'Typography',
  fill: 'Fill',
  border: 'Border',
  effects: 'Effects',
};

const GROUP_ORDER: StyleGroup[] = [
  'layout',
  'grid',
  'flexChild',
  'size',
  'spacing',
  'position',
  'typography',
  'fill',
  'border',
  'effects',
];

export interface InspectorGroup {
  group: StyleGroup;
  label: string;
  props: StylePropName[];
}

/** Every StyleProp, grouped by its `group`, in inspector order. */
export function inspectorGroups(): InspectorGroup[] {
  return GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    props: STYLE_PROP_NAMES.filter((p) => STYLE_PROPS[p].group === group),
  }));
}

/* Zod schemas are inspected structurally (enum `options`, union `options`, literal `values`). */
type Schemaish = { options?: unknown; values?: unknown; value?: unknown };

function keywordsOf(s: Schemaish): string[] {
  const o = s.options;
  if (Array.isArray(o)) {
    if (o.every((x) => typeof x === 'string')) return o as string[];
    return o.flatMap((x) => keywordsOf(x as Schemaish));
  }
  if (s.values instanceof Set)
    return [...s.values].filter((x): x is string => typeof x === 'string');
  if (typeof s.value === 'string') return [s.value];
  return [];
}

/** Keyword values a prop accepts (all of them for enums; e.g. hug/fill/auto for width). */
export function propKeywords(prop: StylePropName): string[] {
  return keywordsOf(STYLE_PROPS[prop].schema as unknown as Schemaish);
}

/** True when the prop only accepts a fixed set of keywords (rendered as a select). */
export function isEnumProp(prop: StylePropName): boolean {
  const o = (STYLE_PROPS[prop].schema as unknown as Schemaish).options;
  return Array.isArray(o) && o.every((x) => typeof x === 'string');
}

/** Props whose literal is a plain number or a length, so scrubbing and arrow keys make sense. */
export function isNumericProp(prop: StylePropName): boolean {
  return !isEnumProp(prop) && validateStyleValue(prop, 1).success;
}

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

const NUM = /^-?(?:\d+\.?\d*|\.\d+)$/;
const PX = /^(-?(?:\d+\.?\d*|\.\d+))px$/;

/**
 * Text input -> style value. Empty unsets (null). Bare numbers and `Npx` become px numbers,
 * which is what the renderer and the Tailwind mapping expect.
 */
export function parseStyleInput(prop: StylePropName, raw: string): ParseResult {
  const s = raw.trim();
  if (s === '') return { ok: true, value: null };
  const candidates: unknown[] = [];
  if (NUM.test(s)) candidates.push(Number(s));
  const px = PX.exec(s);
  if (px) candidates.push(Number(px[1]));
  candidates.push(s);
  let error = 'Invalid value';
  for (const c of candidates) {
    const r = validateStyleValue(prop, c);
    if (r.success) return { ok: true, value: r.data };
    error = r.error.issues[0]?.message ?? error;
  }
  return { ok: false, error };
}

/** Display text for a literal value (tokens are shown separately). */
export function formatStyleValue(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (isTokenRef(v)) return v.token;
  return String(v);
}

/** Next value for an arrow-key nudge or scrub step; null if the value isn't numeric. */
export function nudge(prop: StylePropName, current: unknown, delta: number): unknown {
  let n: number | null = null;
  let unit = '';
  if (typeof current === 'number') n = current;
  else if (current === undefined || current === null) n = 0;
  else if (typeof current === 'string') {
    const m = /^(-?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/.exec(current);
    if (m) {
      n = Number(m[1]);
      unit = m[2] ?? '';
    }
  }
  if (n === null) return null;
  const step = prop === 'opacity' || prop === 'scale' || prop === 'lineHeight' ? delta / 10 : delta;
  const next = Math.round((n + step) * 100) / 100;
  const value = unit && unit !== 'px' ? `${next}${unit}` : next;
  const r = validateStyleValue(prop, value);
  return r.success ? r.data : null;
}

export interface TokenOption {
  path: string;
  type: TokenType;
  /** Resolved literal (for swatches and previews), or null if it can't be resolved. */
  resolved: string | number | null;
}

/** Design-system tokens offered for a prop, filtered by the prop's token kinds. */
export function tokensForProp(prop: StylePropName, ds: DesignSystemSpec): TokenOption[] {
  const kinds = (STYLE_PROPS[prop] as { tokens?: readonly TokenType[] }).tokens;
  if (!kinds?.length) return [];
  return Object.entries(ds.tokens)
    .filter(([, t]) => kinds.includes(t.type))
    .map(([path, t]) => {
      let resolved: string | number | null = null;
      try {
        resolved = resolveToken(ds.tokens, path);
      } catch {
        resolved = null;
      }
      return { path, type: t.type, resolved };
    })
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

export interface PropState {
  /** Effective value at the breakpoint (own or inherited). */
  value: unknown;
  /** Breakpoint the effective value comes from, or null if unset everywhere. */
  from: Breakpoint | null;
  /** Set at exactly this breakpoint (can be reset here). */
  setHere: boolean;
  /** Inherited from a smaller breakpoint. */
  inherited: boolean;
  /** Breakpoints that set this prop at all (for the per-breakpoint dots). */
  setAt: Breakpoint[];
}

export function propState(style: ResponsiveStyle, prop: StylePropName, bp: Breakpoint): PropState {
  const r = resolveAt(style, prop, bp);
  const setAt = (['base', 'md', 'lg'] as const).filter((b) => style[b]?.[prop] !== undefined);
  return {
    value: r.value,
    from: r.from,
    setHere: r.from === bp,
    inherited: r.from !== null && r.from !== bp,
    setAt,
  };
}

/**
 * The value shared by every node for a prop at a breakpoint, or 'mixed'.
 * Used for multi-selection editing.
 */
export function sharedValue(
  styles: readonly ResponsiveStyle[],
  prop: StylePropName,
  bp: Breakpoint,
) {
  const vals = styles.map((s) => JSON.stringify(resolveAt(s, prop, bp).value ?? null));
  return vals.every((v) => v === vals[0]) ? 'same' : 'mixed';
}
