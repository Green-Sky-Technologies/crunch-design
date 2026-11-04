/**
 * Primitive style value validators.
 *
 * Every value that can reach rendered CSS is validated here against a strict grammar.
 * There's no free-form CSS: no `;`, `{`, `}`, `<`, comments, `expression()`, or arbitrary
 * `url()`. This is a security boundary (SPEC 9.3): agent output and imported designs are untrusted.
 */
import { z } from 'zod';

/** Reference to a design-system token, e.g. { token: 'color.primary' }. */
export const tokenPath = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+)+$/, 'Invalid token path (expected group.name)');
export const tokenRef = z.object({ token: tokenPath }).strict();
export type TokenRef = z.infer<typeof tokenRef>;

export const isTokenRef = (v: unknown): v is TokenRef =>
  typeof v === 'object' && v !== null && 'token' in v && typeof (v as TokenRef).token === 'string';

const num = String.raw`-?(?:\d+\.?\d*|\.\d+)`;
const lengthUnit = String.raw`(?:px|rem|em|%|vw|vh|svh|dvh|ch)`;
const lengthRe = new RegExp(`^${num}${lengthUnit}$`);

/** Px number, or a CSS length string with an allowed unit. */
export const length = z.union([z.number().finite(), z.string().regex(lengthRe, 'Invalid length')]);

/** Width/height: length, `auto`, or the auto-layout keywords `hug` (fit-content) and `fill`. */
export const sizeValue = z.union([length, z.enum(['auto', 'hug', 'fill'])]);
export const minMaxSize = z.union([length, z.enum(['none', 'auto'])]);
export const inset = z.union([length, z.literal('auto')]);

const hex = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const fn = /^(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(\s*[-0-9.%\s,/a-z]+\)$/i;
export const color = z.union([
  z.string().regex(hex),
  z.string().regex(fn),
  z.enum(['transparent', 'currentColor', 'white', 'black']),
]);

export const fontWeight = z.union([z.number().int().min(100).max(900), z.enum(['normal', 'bold'])]);

/** Font family list: names with letters, digits, spaces, hyphens; optional quotes; comma-separated. */
export const fontFamily = z
  .string()
  .max(200)
  .regex(
    /^\s*(?:"[\w\s-]+"|'[\w\s-]+'|[\w-]+(?:\s[\w-]+)*)(?:\s*,\s*(?:"[\w\s-]+"|'[\w\s-]+'|[\w-]+(?:\s[\w-]+)*))*\s*$/,
  );

/** Unitless (line-height 1.5), or length. */
export const lineHeight = z.union([z.number().positive().max(10), length, z.literal('normal')]);

export const opacity = z.number().min(0).max(1);
export const zIndex = z.number().int().min(-100).max(10000);

/**
 * Box shadow: one or more `x y blur? spread? color inset?` layers, built from validated
 * lengths and colors.
 */
const shadowLayer = new RegExp(
  `^(?:inset\\s+)?(?:${num}(?:px|rem|em)?\\s+){1,3}${num}(?:px|rem|em)?(?:\\s+(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|oklch)\\([-0-9.%\\s,/]+\\)|transparent))?(?:\\s+inset)?$`,
);
export const boxShadow = z.union([
  z.literal('none'),
  z
    .string()
    .max(400)
    .refine(
      (s) => s.split(/,(?![^(]*\))/).every((layer) => shadowLayer.test(layer.trim())),
      'Invalid box-shadow',
    ),
]);

/** Gradients only with validated colors/stops; images only via `src` on image nodes or https/asset URLs. */
const gradientRe =
  /^(?:linear|radial)-gradient\(\s*(?:(?:-?\d+(?:\.\d+)?deg|to (?:top|bottom|left|right)(?: (?:top|bottom|left|right))?|circle|ellipse)\s*,\s*)?(?:(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|oklch)\([-0-9.%\s,/]+\)|transparent)(?:\s+-?\d+(?:\.\d+)?%)?\s*,\s*)+(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|oklch)\([-0-9.%\s,/]+\)|transparent)(?:\s+-?\d+(?:\.\d+)?%)?\s*\)$/;
export const backgroundImage = z.union([
  z.literal('none'),
  z.string().max(600).regex(gradientRe, 'Only linear/radial gradients are allowed'),
]);

/** Grid track lists: repeat(n, 1fr), minmax(), lengths, fr, auto. */
const GRID_WORDS = new Set([
  'none',
  'repeat',
  'minmax',
  'auto',
  'min-content',
  'max-content',
  'auto-fill',
  'auto-fit',
  'fr',
  'px',
  'rem',
  'em',
]);
export const gridTemplate = z
  .string()
  .max(200)
  .refine((s) => {
    if (!/^[0-9a-z.%(),\s-]+$/.test(s)) return false;
    let depth = 0;
    for (const ch of s) {
      if (ch === '(') depth++;
      if (ch === ')' && --depth < 0) return false;
    }
    if (depth !== 0) return false;
    const words = s.match(/[a-z][a-z-]*/g) ?? [];
    return words.every((w) => GRID_WORDS.has(w));
  }, 'Invalid grid template');
export const gridPlacement = z
  .string()
  .max(40)
  .regex(/^(?:auto|span \d+|-?\d+(?:\s*\/\s*(?:-?\d+|span \d+))?)$/);

export const transformNumber = z.number().finite().min(-10000).max(10000);

/** Safe URL for images/links: https, relative app asset paths, or data:image (no SVG). */
export const safeImageSrc = z
  .string()
  .max(4096)
  .refine(
    (s) =>
      /^https:\/\/[^\s"'<>]+$/.test(s) ||
      /^\/[a-zA-Z0-9/_\-.]+$/.test(s) ||
      /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/.test(s),
    'Image src must be https, an app asset path, or a base64 raster data URL',
  );

export const safeHref = z
  .string()
  .max(2048)
  .refine(
    (s) => /^(?:https?:\/\/|mailto:|tel:|#|\/)[^\s"'<>]*$/.test(s),
    'Links must be http(s), mailto, tel, an anchor, or a relative path',
  );
