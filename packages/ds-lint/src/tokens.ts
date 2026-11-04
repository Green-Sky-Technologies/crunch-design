/**
 * A lookup index over a design system's tokens, resolved once per lint run: theme and valid
 * project overrides applied, values normalized so literals can be matched to tokens exactly
 * ("#FFF" = "#ffffff", "1rem" = 16 = "16px", "bold" = 700) or by distance.
 */
import {
  isValidTokenValue,
  resolveToken,
  type DesignDoc,
  type DesignSystemSpec,
  type TokenKind,
  type TokenType,
} from '@crunch/doc-model';
import { colorDistance, parseColor, type Rgba } from './color';

export const REM_PX = 16;

export interface IndexedToken {
  path: string;
  type: TokenType;
  value: string | number;
  /** Lengths in px (dimension/radius/fontSize, lineHeight lengths). */
  px?: number;
  /** Plain numbers (fontWeight, unitless lineHeight, number). */
  num?: number;
  color?: Rgba;
  /** Normalized match key. */
  key: string;
  alias: boolean;
}

/** Length → px. Numbers are px; rem/em use 16px (em is approximate). Others → undefined. */
export function lengthPx(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const m = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em)$/.exec(v.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2] === 'px' ? n : n * REM_PX;
}

export function weightNum(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (v === 'normal') return 400;
  if (v === 'bold') return 700;
  return undefined;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function normalizeFontFamily(v: string): string {
  return v
    .split(',')
    .map((f) =>
      f
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .toLowerCase(),
    )
    .filter(Boolean)
    .join(',');
}

export const primaryFamily = (v: string) => normalizeFontFamily(v).split(',')[0] ?? '';

/** Normalized key for a literal of a token kind, or null if it can't be compared. */
export function literalKey(kind: TokenKind, v: unknown): string | null {
  switch (kind) {
    case 'color': {
      if (typeof v !== 'string') return null;
      const c = parseColor(v);
      return c ? `c:${round(c.r)},${round(c.g)},${round(c.b)},${round(c.a)}` : null;
    }
    case 'dimension':
    case 'radius':
    case 'fontSize': {
      const px = lengthPx(v);
      return px === undefined
        ? typeof v === 'string'
          ? `s:${v.trim()}`
          : null
        : `px:${round(px)}`;
    }
    case 'fontWeight': {
      const n = weightNum(v);
      return n === undefined ? null : `n:${n}`;
    }
    case 'lineHeight':
      if (typeof v === 'number') return `n:${round(v)}`;
      return literalKey('dimension', v);
    case 'number':
      return typeof v === 'number' ? `n:${round(v)}` : null;
    case 'fontFamily':
      return typeof v === 'string' ? `f:${normalizeFontFamily(v)}` : null;
    case 'shadow':
      return typeof v === 'string' ? `sh:${v.trim().replace(/\s+/g, ' ').toLowerCase()}` : null;
  }
}

/** Which token kinds a token type can stand in for. */
const KINDS_OF: Record<TokenType, TokenKind[]> = {
  color: ['color'],
  dimension: ['dimension'],
  radius: ['radius'],
  fontSize: ['fontSize'],
  fontFamily: ['fontFamily'],
  fontWeight: ['fontWeight'],
  lineHeight: ['lineHeight'],
  shadow: ['shadow'],
  number: ['number'],
};

export class TokenIndex {
  readonly byKind = new Map<TokenKind, IndexedToken[]>();
  private readonly exact = new Map<string, IndexedToken>();
  private readonly resolved = new Map<string, string | number | null>();
  private nearestCache = new Map<string, IndexedToken | null>();

  constructor(
    readonly ds: DesignSystemSpec,
    doc: Pick<DesignDoc, 'tokenOverrides'>,
    themeName?: string,
  ) {
    const theme = themeName ? ds.themes[themeName] : undefined;
    // Valid project overrides behave like theme values (the renderer applies them on top).
    const merged: Record<string, string | number | { ref: string }> = { ...theme };
    for (const [p, v] of Object.entries(doc.tokenOverrides ?? {})) {
      const def = ds.tokens[p];
      if (def && isValidTokenValue(def.type, v)) merged[p] = v;
    }
    // Non-alias tokens first, then alphabetical, so exact matches prefer the canonical token.
    const paths = Object.keys(ds.tokens).sort((a, b) => {
      const aa = typeof ds.tokens[a]!.value === 'object' ? 1 : 0;
      const ba = typeof ds.tokens[b]!.value === 'object' ? 1 : 0;
      return aa - ba || (a < b ? -1 : a > b ? 1 : 0);
    });
    for (const path of paths) {
      const def = ds.tokens[path]!;
      let value: string | number;
      try {
        value = resolveToken(ds.tokens, path, merged);
      } catch {
        this.resolved.set(path, null);
        continue;
      }
      this.resolved.set(path, value);
      for (const kind of KINDS_OF[def.type]) {
        const key = literalKey(kind, value);
        if (key === null) continue;
        const t: IndexedToken = {
          path,
          type: def.type,
          value,
          key,
          alias: typeof def.value === 'object',
          px: lengthPx(value),
          num: typeof value === 'number' ? value : weightNum(value),
          color:
            kind === 'color' && typeof value === 'string'
              ? (parseColor(value) ?? undefined)
              : undefined,
        };
        const list = this.byKind.get(kind) ?? [];
        list.push(t);
        this.byKind.set(kind, list);
        const ek = `${kind}|${key}`;
        if (!this.exact.has(ek)) this.exact.set(ek, t);
      }
    }
  }

  has(path: string): boolean {
    return path in this.ds.tokens;
  }

  /** Resolved literal, or null for unknown/unresolvable tokens. */
  resolve(path: string): string | number | null {
    return this.resolved.get(path) ?? null;
  }

  hasKind(kind: TokenKind): boolean {
    return (this.byKind.get(kind)?.length ?? 0) > 0;
  }

  /** A token whose value equals the literal, preferring kinds in order. */
  exactMatch(kinds: readonly TokenKind[], literal: unknown): IndexedToken | undefined {
    for (const kind of kinds) {
      const key = literalKey(kind, literal);
      if (key === null) continue;
      const t = this.exact.get(`${kind}|${key}`);
      if (t) return t;
    }
    return undefined;
  }

  /** Closest numeric (px or plain number) token of a kind, with its absolute distance. */
  nearestNumeric(
    kind: TokenKind,
    n: number,
    unit: 'px' | 'num',
  ): { token: IndexedToken; diff: number } | undefined {
    let best: { token: IndexedToken; diff: number } | undefined;
    for (const t of this.byKind.get(kind) ?? []) {
      const v = unit === 'px' ? t.px : t.num;
      if (v === undefined) continue;
      const diff = Math.abs(v - n);
      // Ties go to the smaller value, then to the earlier (canonical) token.
      if (
        !best ||
        diff < best.diff ||
        (diff === best.diff && v < (unit === 'px' ? best.token.px! : best.token.num!))
      )
        best = { token: t, diff };
    }
    return best;
  }

  /** Closest color token (CIEDE2000), cached per literal. */
  nearestColor(c: Rgba): { token: IndexedToken; distance: number } | undefined {
    const key = `${c.r},${c.g},${c.b},${c.a}`;
    let tok = this.nearestCache.get(key);
    if (tok === undefined) {
      tok = null;
      let best = Infinity;
      for (const t of this.byKind.get('color') ?? []) {
        if (!t.color || t.color.a !== c.a) continue;
        const d = colorDistance(c, t.color);
        if (d < best) {
          best = d;
          tok = t;
        }
      }
      if (this.nearestCache.size > 5000) this.nearestCache = new Map();
      this.nearestCache.set(key, tok);
    }
    return tok && tok.color ? { token: tok, distance: colorDistance(c, tok.color) } : undefined;
  }
}
