/** Parsers for composite CSS values (box-shadow, gradients) into Figma effects/paints. */
import { parseCssColor } from './color';
import type { EffectSpec, PaintSpec, Rgba } from './plan';
import { toPx } from './units';

/** Split on commas that aren't inside parentheses. */
export function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Tokens separated by whitespace outside parentheses. */
function words(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

const BLACK_25: Rgba = { r: 0, g: 0, b: 0, a: 0.25 };

/** `box-shadow` -> Figma shadow effects. Returns null if any layer can't be parsed. */
export function parseBoxShadow(value: string, fontSize = 16): EffectSpec[] | null {
  if (value.trim() === 'none') return [];
  const effects: EffectSpec[] = [];
  for (const layer of splitTopLevel(value)) {
    const parts = words(layer);
    let inset = false;
    let color: Rgba | null = null;
    const lengths: number[] = [];
    for (const p of parts) {
      if (p === 'inset') inset = true;
      else if (/^-?(?:\d|\.\d)/.test(p)) {
        const px = toPx(/^-?[\d.]+$/.test(p) ? `${p}px` : p, { fontSize });
        if (px === null) return null;
        lengths.push(px);
      } else {
        color = parseCssColor(p);
        if (!color) return null;
      }
    }
    if (lengths.length < 2) return null;
    effects.push({
      type: inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
      color: color ?? BLACK_25,
      offset: { x: lengths[0]!, y: lengths[1]! },
      radius: lengths[2] ?? 0,
      spread: lengths[3] ?? 0,
    });
  }
  return effects;
}

const DIRS: Record<string, number> = {
  'to top': 0,
  'to right': 90,
  'to bottom': 180,
  'to left': 270,
  'to top right': 45,
  'to right top': 45,
  'to bottom right': 135,
  'to right bottom': 135,
  'to bottom left': 225,
  'to left bottom': 225,
  'to top left': 315,
  'to left top': 315,
};

/**
 * CSS gradient -> Figma gradient paint. Figma's gradientTransform maps the paint's unit square to
 * gradient space; for a CSS angle θ (0 = up, clockwise) we rotate around the center so the
 * gradient runs along θ. Radial gradients map to a centered radial paint.
 */
export function parseGradient(value: string): PaintSpec | null {
  const m = /^(linear|radial)-gradient\((.*)\)$/s.exec(value.trim());
  if (!m) return null;
  const parts = splitTopLevel(m[2]!);
  let angle = 180;
  if (m[1] === 'linear') {
    const first = parts[0]!;
    const deg = /^(-?\d+(?:\.\d+)?)deg$/.exec(first);
    if (deg) {
      angle = parseFloat(deg[1]!);
      parts.shift();
    } else if (first in DIRS) {
      angle = DIRS[first]!;
      parts.shift();
    }
  } else if (/^(circle|ellipse)$/.test(parts[0]!)) parts.shift();

  const stops: { position: number; color: Rgba }[] = [];
  parts.forEach((p, i) => {
    const w = words(p);
    const color = parseCssColor(w[0]!);
    if (!color) return;
    const pos = w[1]?.endsWith('%')
      ? parseFloat(w[1]) / 100
      : parts.length > 1
        ? i / (parts.length - 1)
        : 0;
    stops.push({ position: Math.min(1, Math.max(0, pos)), color });
  });
  if (stops.length < 2 || stops.length !== parts.length) return null;

  if (m[1] === 'radial') {
    return {
      type: 'GRADIENT_RADIAL',
      transform: [
        [1, 0, 0],
        [0, 1, 0],
      ],
      stops,
    };
  }
  // Figma's default linear gradient runs left -> right (CSS 90deg). Rotate by (angle - 90).
  const rad = ((angle - 90) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const r = (n: number) => Math.round(n * 1e4) / 1e4;
  // Inverse rotation about (0.5, 0.5): maps node space to gradient space.
  const a = cos;
  const b = sin;
  const c = -sin;
  const d = cos;
  const tx = 0.5 - a * 0.5 - b * 0.5;
  const ty = 0.5 - c * 0.5 - d * 0.5;
  return {
    type: 'GRADIENT_LINEAR',
    transform: [
      [r(a), r(b), r(tx)],
      [r(c), r(d), r(ty)],
    ],
    stops,
  };
}
