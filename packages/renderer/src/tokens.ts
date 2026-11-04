/**
 * Compile design-system tokens to CSS custom properties (Story 2.2).
 *
 * - Every token becomes `--group-name: value`. Aliases become `var(--target)`, so changing the
 *   target updates the alias too.
 * - Themes become scoped blocks: `[data-theme="dark"]`.
 * - Project-level overrides (DesignDoc.tokenOverrides) are validated against the token's
 *   type and emitted after the base values. Invalid or unknown overrides are reported and dropped.
 */
import {
  isValidTokenValue,
  tokenCssVar,
  type DesignSystemSpec,
  type TokenDef,
  type TokenMap,
  type TokenType,
} from '@crunch/doc-model';

const UNITLESS: ReadonlySet<TokenType> = new Set(['fontWeight', 'lineHeight', 'number']);

/** Format a literal token value as CSS. */
export function tokenValueCss(type: TokenType, value: string | number): string {
  if (typeof value === 'number') return UNITLESS.has(type) ? String(value) : `${value}px`;
  return value;
}

function defCss(
  tokens: TokenMap,
  def: TokenDef | { type: TokenType; value: TokenDef['value'] },
): string | null {
  const v = def.value;
  if (typeof v === 'object') return tokens[v.ref] ? `var(${tokenCssVar(v.ref)})` : null;
  return tokenValueCss(def.type, v);
}

export interface CompiledTokens {
  /** `--name: value` pairs for the base (no theme) scope, overrides applied. */
  vars: Record<string, string>;
  /** Per theme, the vars that differ from base. */
  themes: Record<string, Record<string, string>>;
  /** Overrides that were rejected, with the reason. */
  warnings: string[];
}

export function compileTokens(
  ds: Pick<DesignSystemSpec, 'tokens' | 'themes'>,
  overrides: Record<string, string | number> = {},
): CompiledTokens {
  const vars: Record<string, string> = {};
  const warnings: string[] = [];
  const paths = Object.keys(ds.tokens).sort(); // deterministic output (stable cache keys/snapshots)

  for (const path of paths) {
    const css = defCss(ds.tokens, ds.tokens[path]!);
    if (css === null) warnings.push(`Token ${path} aliases an unknown token`);
    else vars[tokenCssVar(path)] = css;
  }

  for (const path of Object.keys(overrides).sort()) {
    const def = ds.tokens[path];
    const value = overrides[path]!;
    if (!def) {
      warnings.push(`Override for unknown token ${path} ignored`);
      continue;
    }
    if (!isValidTokenValue(def.type, value)) {
      warnings.push(`Override for ${path} is not a valid ${def.type}`);
      continue;
    }
    vars[tokenCssVar(path)] = tokenValueCss(def.type, value);
  }

  const themes: Record<string, Record<string, string>> = {};
  for (const name of Object.keys(ds.themes ?? {}).sort()) {
    const t = ds.themes[name]!;
    const out: Record<string, string> = {};
    for (const path of Object.keys(t).sort()) {
      const def = ds.tokens[path];
      if (!def) continue;
      const v = t[path]!;
      if (typeof v !== 'object' && !isValidTokenValue(def.type, v)) {
        warnings.push(`Theme ${name}: invalid ${def.type} for ${path}`);
        continue;
      }
      // Project overrides win over themes too.
      if (path in overrides) continue;
      const css = defCss(ds.tokens, { type: def.type, value: v });
      if (css !== null) out[tokenCssVar(path)] = css;
    }
    themes[name] = out;
  }
  return { vars, themes, warnings };
}

const block = (selector: string, vars: Record<string, string>) =>
  `${selector}{${Object.entries(vars)
    .map(([k, v]) => `${k}:${v};`)
    .join('')}}`;

/** CSS text for compiled tokens. `scope` is the selector the variables live on. */
export function tokensToCss(compiled: CompiledTokens, scope: string): string {
  const parts = [block(scope, compiled.vars)];
  for (const [name, vars] of Object.entries(compiled.themes)) {
    if (Object.keys(vars).length) parts.push(block(`${scope}[data-theme="${name}"]`, vars));
  }
  return parts.join('\n');
}
