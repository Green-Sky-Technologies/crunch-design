/** CSS color <-> Figma RGBA (0..1 channels). */
import type { Rgba } from './plan';

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const round = (n: number, p = 4) => Math.round(n * 10 ** p) / 10 ** p;

function hexToRgba(hex: string): Rgba | null {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: round(n(0)), g: round(n(2)), b: round(n(4)), a: h.length === 8 ? round(n(6)) : 1 };
}

function channel(s: string, max: number): number {
  s = s.trim();
  if (s.endsWith('%')) return clamp01(parseFloat(s) / 100);
  return clamp01(parseFloat(s) / max);
}

function alpha(s: string | undefined): number {
  if (s === undefined) return 1;
  s = s.trim();
  return s.endsWith('%') ? clamp01(parseFloat(s) / 100) : clamp01(parseFloat(s));
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [r + m, g + m, b + m];
}

/** Split `rgb(1 2 3 / 50%)` or `rgb(1, 2, 3, 0.5)` into components. */
function args(inner: string): string[] {
  const [main, slashAlpha] = inner.split('/');
  const parts = main!
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (slashAlpha !== undefined) parts.push(slashAlpha.trim());
  return parts;
}

/** Parse a CSS color literal (as allowed by doc-model). Returns null for unsupported spaces. */
export function parseCssColor(input: string): Rgba | null {
  const s = input.trim();
  const lower = s.toLowerCase();
  if (lower === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (lower === 'white') return { r: 1, g: 1, b: 1, a: 1 };
  if (lower === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  if (s.startsWith('#')) return hexToRgba(s);
  const m = /^(rgba?|hsla?)\((.*)\)$/i.exec(s);
  if (!m) return null; // oklch/oklab/lab/lch/currentColor: handled by callers
  const fn = m[1]!.toLowerCase();
  const p = args(m[2]!);
  if (p.length < 3) return null;
  if (fn.startsWith('rgb')) {
    return {
      r: round(channel(p[0]!, 255)),
      g: round(channel(p[1]!, 255)),
      b: round(channel(p[2]!, 255)),
      a: round(alpha(p[3])),
    };
  }
  const [r, g, b] = hslToRgb(parseFloat(p[0]!), channel(p[1]!, 100), channel(p[2]!, 100));
  return { r: round(r), g: round(g), b: round(b), a: round(alpha(p[3])) };
}

const hex2 = (n: number) =>
  Math.round(clamp01(n) * 255)
    .toString(16)
    .padStart(2, '0');

/** Figma color -> CSS: `#rrggbb` when opaque, `#rrggbbaa` otherwise. */
export function rgbaToCss(c: { r: number; g: number; b: number; a?: number }, opacity = 1): string {
  const a = clamp01((c.a ?? 1) * opacity);
  const base = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  return a >= 0.999 ? base : `${base}${hex2(a)}`;
}

/** Equal within 8-bit precision. */
export function sameColor(a: Rgba, b: Rgba): boolean {
  const q = (n: number) => Math.round(n * 255);
  return q(a.r) === q(b.r) && q(a.g) === q(b.g) && q(a.b) === q(b.b) && q(a.a) === q(b.a);
}
