/** CSS length -> px, for Figma (which only has px). */

export const ROOT_FONT_SIZE = 16;

export interface LengthContext {
  /** Font size for `em` (px). */
  fontSize?: number;
  /** Basis for `%` (px), when known. */
  percentOf?: number;
  /** Viewport (frame) size for vw/vh. */
  viewport?: { width: number; height: number };
}

const LENGTH_RE = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|%|vw|vh|svh|dvh|ch)$/;

/** Returns px, or null when the length can't be resolved (e.g. % with no basis). */
export function toPx(value: unknown, ctx: LengthContext = {}): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const m = LENGTH_RE.exec(value.trim());
  if (!m) return null;
  const n = parseFloat(m[1]!);
  switch (m[2]) {
    case 'px':
      return n;
    case 'rem':
      return n * ROOT_FONT_SIZE;
    case 'em':
      return n * (ctx.fontSize ?? ROOT_FONT_SIZE);
    case 'ch':
      return n * (ctx.fontSize ?? ROOT_FONT_SIZE) * 0.5;
    case '%':
      return ctx.percentOf !== undefined ? (n / 100) * ctx.percentOf : null;
    case 'vw':
      return ctx.viewport ? (n / 100) * ctx.viewport.width : null;
    case 'vh':
    case 'svh':
    case 'dvh':
      return ctx.viewport ? (n / 100) * ctx.viewport.height : null;
    default:
      return null;
  }
}

export const roundPx = (n: number) => Math.round(n * 100) / 100;
