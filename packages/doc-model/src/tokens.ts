/**
 * Design-system tokens. A flat map of dotted paths to typed values, plus theme overrides
 * (light/dark, matching Figma variable modes). A value can alias another token.
 */
import { z } from 'zod';
import * as v from './values';

export const TOKEN_TYPES = [
  'color',
  'dimension',
  'fontFamily',
  'fontWeight',
  'fontSize',
  'lineHeight',
  'shadow',
  'number',
  'radius',
] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];

const alias = z.object({ ref: v.tokenPath }).strict();

const byType = {
  color: v.color,
  dimension: v.length,
  radius: v.length,
  fontSize: v.length,
  fontFamily: v.fontFamily,
  fontWeight: v.fontWeight,
  lineHeight: v.lineHeight,
  shadow: v.boxShadow,
  number: z.number().finite(),
} satisfies Record<TokenType, z.ZodType>;

export const tokenDef = z
  .object({
    type: z.enum(TOKEN_TYPES),
    value: z.union([z.string(), z.number(), alias]),
    description: z.string().max(500).optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (typeof t.value === 'object') return; // alias, checked against the map
    const r = byType[t.type].safeParse(t.value);
    if (!r.success)
      ctx.addIssue({ code: 'custom', message: `Invalid ${t.type} value`, path: ['value'] });
  });
export type TokenDef = z.infer<typeof tokenDef>;

export const tokenMap = z.record(v.tokenPath, tokenDef);
export type TokenMap = z.infer<typeof tokenMap>;

/** Theme = partial overrides of token values (e.g. dark mode). */
export const themes = z.record(
  z.string().regex(/^[a-z][a-z0-9-]*$/),
  z.record(v.tokenPath, z.union([z.string(), z.number(), alias])),
);
export type Themes = z.infer<typeof themes>;

export class TokenResolutionError extends Error {
  override name = 'TokenResolutionError';
}

/** Resolve a token (following aliases, applying an optional theme) to a literal. */
export function resolveToken(
  tokens: TokenMap,
  path: string,
  theme?: Record<string, TokenDef['value']>,
  seen: Set<string> = new Set(),
): string | number {
  if (seen.has(path)) throw new TokenResolutionError(`Token alias cycle at "${path}"`);
  seen.add(path);
  const def = tokens[path];
  if (!def) throw new TokenResolutionError(`Unknown token "${path}"`);
  const raw = theme?.[path] ?? def.value;
  if (typeof raw === 'object') return resolveToken(tokens, raw.ref, theme, seen);
  return raw;
}

/** CSS custom property name for a token path: color.primary → --color-primary */
export function tokenCssVar(path: string): string {
  return `--${path.replace(/\./g, '-')}`;
}

/** Validate a literal against a token type (used for doc-level overrides and imports). */
export function isValidTokenValue(type: TokenType, value: unknown): boolean {
  return byType[type].safeParse(value).success;
}
