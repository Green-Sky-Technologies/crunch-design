/**
 * DesignSystemSpec tokens -> Figma variables (Story 8.2 push, Story 8.4 sync).
 *
 * One collection; the first mode holds base token values and every DesignSystemSpec theme becomes
 * another mode (light/dark). Token paths map to slash-separated variable names
 * (`color.primary` <-> `color/primary`), which is how Figma groups variables.
 */
import type { DesignSystemSpec, TokenDef, TokenType } from '@crunch/doc-model';
import { parseCssColor } from './color';
import type { VariableSpec, VariablesSpec, VariableType, VariableValueSpec } from './plan';
import type { Reporter } from './report';
import { toPx } from './units';

export const DEFAULT_COLLECTION = 'CrunchDesign tokens';
export const BASE_MODE = 'light';

export const tokenPathToVariableName = (path: string) => path.split('.').join('/');

/** Figma variable name -> token path, or null if it can't be a valid token path. */
export function variableNameToTokenPath(name: string): string | null {
  const segs = name
    .split('/')
    .map((s) =>
      s
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^a-zA-Z0-9-]/g, ''),
    )
    .filter(Boolean);
  if (segs.length < 2) return null;
  let first = segs[0]!.replace(/-/g, '');
  first = first.charAt(0).toLowerCase() + first.slice(1);
  if (!/^[a-z][a-zA-Z0-9]*$/.test(first)) return null;
  const path = [first, ...segs.slice(1)].join('.');
  return /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+)+$/.test(path) ? path : null;
}

export function variableTypeFor(type: TokenType): VariableType | null {
  switch (type) {
    case 'color':
      return 'COLOR';
    case 'dimension':
    case 'radius':
    case 'fontSize':
    case 'fontWeight':
    case 'number':
    case 'lineHeight':
      return 'FLOAT';
    case 'fontFamily':
      return 'STRING';
    case 'shadow':
      return null;
  }
}

/** A literal token value -> a Figma variable value, or null if not representable. */
export function tokenLiteralToVariable(
  type: TokenType,
  value: string | number,
): VariableValueSpec | null {
  switch (type) {
    case 'color': {
      if (typeof value !== 'string') return null;
      return parseCssColor(value);
    }
    case 'dimension':
    case 'radius':
    case 'fontSize':
      return toPx(value);
    case 'fontWeight':
      return value === 'bold'
        ? 700
        : value === 'normal'
          ? 400
          : typeof value === 'number'
            ? value
            : null;
    case 'number':
      return typeof value === 'number' ? value : null;
    case 'lineHeight':
      // Unitless multipliers are kept as numbers; px lengths become px.
      return typeof value === 'number' ? value : value === 'normal' ? null : toPx(value);
    case 'fontFamily':
      return typeof value === 'string' ? primaryFamily(value) : null;
    case 'shadow':
      return null;
  }
}

/** First family in a CSS font-family list, unquoted. */
export function primaryFamily(list: string): string {
  return list
    .split(',')[0]!
    .trim()
    .replace(/^["']|["']$/g, '');
}

function valueFor(
  def: TokenDef,
  raw: TokenDef['value'],
  spec: DesignSystemSpec,
  pushed: Set<string>,
): VariableValueSpec | null {
  if (typeof raw === 'object') {
    if (pushed.has(raw.ref)) return { alias: raw.ref };
    const target = spec.tokens[raw.ref];
    if (!target || typeof target.value === 'object') return null;
    return tokenLiteralToVariable(def.type, target.value);
  }
  return tokenLiteralToVariable(def.type, raw);
}

export interface TokensToVariablesOptions {
  collectionName?: string;
  /** Only these token paths (default: all). */
  only?: Set<string>;
  report?: Reporter;
}

/** Build the variables part of a push plan from a design system. */
export function tokensToVariables(
  spec: DesignSystemSpec,
  opts: TokensToVariablesOptions = {},
): VariablesSpec {
  const themeNames = Object.keys(spec.themes).filter((t) => t !== BASE_MODE);
  const baseMode = Object.prototype.hasOwnProperty.call(spec.themes, BASE_MODE)
    ? 'base'
    : BASE_MODE;
  const modes = [baseMode, ...themeNames];
  if (baseMode === 'base') modes.push(BASE_MODE);

  const paths = Object.keys(spec.tokens)
    .filter((p) => !opts.only || opts.only.has(p))
    .sort();
  const pushed = new Set(paths.filter((p) => variableTypeFor(spec.tokens[p]!.type) !== null));
  const variables: VariableSpec[] = [];
  for (const path of paths) {
    const def = spec.tokens[path]!;
    const type = variableTypeFor(def.type);
    if (!type) {
      opts.report?.info(`${def.type} tokens have no Figma variable type; not pushed`, {
        subject: path,
      });
      continue;
    }
    const valuesByMode: Record<string, VariableValueSpec> = {};
    let ok = true;
    for (const mode of modes) {
      const themed = mode === baseMode ? undefined : spec.themes[mode]?.[path];
      const v = valueFor(def, themed ?? def.value, spec, pushed);
      if (v === null) {
        ok = false;
        break;
      }
      valuesByMode[mode] = v;
    }
    if (!ok) {
      opts.report?.warn('Token value not representable as a Figma variable; not pushed', {
        subject: path,
      });
      pushed.delete(path);
      continue;
    }
    variables.push({
      path,
      name: tokenPathToVariableName(path),
      type,
      valuesByMode,
      ...(def.description ? { description: def.description } : {}),
    });
  }
  // Aliases to tokens that ended up not pushed fall back to null; drop those variables too.
  const names = new Set(variables.map((v) => v.path));
  const valid = variables.filter((v) =>
    Object.values(v.valuesByMode).every(
      (val) => typeof val !== 'object' || !('alias' in val) || names.has(val.alias),
    ),
  );
  return { collectionName: opts.collectionName ?? DEFAULT_COLLECTION, modes, variables: valid };
}
