/**
 * Color math for the linter (culori): parsing with a cache, alpha compositing, WCAG 2.x
 * contrast and CIEDE2000 distance.
 */
import { converter, differenceCiede2000, formatHex8, parse, wcagContrast, type Rgb } from 'culori';

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

const toRgb = converter('rgb');
const cache = new Map<string, Rgba | null>();
const deltaE = differenceCiede2000();

/** Parse a CSS color (hex, rgb(), hsl(), oklch(), named). `currentColor` and junk → null. */
export function parseColor(input: string): Rgba | null {
  const key = input.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let out: Rgba | null = null;
  if (key !== 'currentcolor') {
    const parsed = parse(key);
    const rgb = parsed ? toRgb(parsed) : undefined;
    if (rgb)
      out = {
        r: clamp(rgb.r),
        g: clamp(rgb.g),
        b: clamp(rgb.b),
        a: rgb.alpha === undefined ? 1 : clamp(rgb.alpha),
      };
  }
  if (cache.size > 5000) cache.clear();
  cache.set(key, out);
  return out;
}

const clamp = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Composite `top` over an opaque `bottom` (source-over). */
export function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

const asCulori = (c: Rgba): Rgb => ({ mode: 'rgb', r: c.r, g: c.g, b: c.b, alpha: c.a });

/** WCAG contrast ratio of an opaque foreground on an opaque background (1..21). */
export function contrast(fg: Rgba, bg: Rgba): number {
  return wcagContrast(asCulori(fg), asCulori(bg));
}

/** Perceptual distance (CIEDE2000). ~2 is barely noticeable; >10 is a different color. */
export function colorDistance(a: Rgba, b: Rgba): number {
  return deltaE(asCulori(a), asCulori(b));
}

export function hex(c: Rgba): string {
  const h = formatHex8(asCulori(c));
  return h.endsWith('ff') ? h.slice(0, 7) : h;
}
