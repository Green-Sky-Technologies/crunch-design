/**
 * Token sync with Figma variables (Story 8.4).
 *
 * Both sides are normalized into a TokenSet (base tokens + theme overrides, in DesignSystemSpec
 * literal form). The diff compares CrunchDesign ("ours") with Figma ("theirs"), using the state
 * at the last sync ("base") when there is one:
 *   - only the source side changed since base   -> `changed` (safe to apply)
 *   - both sides changed, or no base exists      -> `conflict` (needs an explicit choice)
 *   - only the target side changed               -> not listed (applying would revert it)
 * Conflicts are never auto-resolved: applying a selected conflict without a resolution throws.
 *
 * Light/dark: the collection's default mode holds base values; every other mode is a theme named
 * after the mode (lowercased), matching DesignSystemSpec.themes.
 */
import {
  designSystemSpec,
  isValidTokenValue,
  type DesignSystemSpec,
  type TokenDef,
  type TokenType,
} from '@crunch/doc-model';
import { z } from 'zod';
import { parseCssColor, rgbaToCss, sameColor } from './color';
import type { VariablesSpec } from './plan';
import { Reporter } from './report';
import type {
  DiffStatus,
  Resolution,
  SnapshotCollection,
  SnapshotValue,
  TokenDiff,
  TokenDiffEntry,
  VariablesSnapshot,
} from './sync-types';
import { themeName } from './modes';
import { toPx } from './units';
import {
  primaryFamily,
  tokensToVariables,
  variableNameToTokenPath,
  variableTypeFor,
} from './variables';

export type TokenValue = TokenDef['value'];
export interface TokenSet {
  tokens: Record<string, { type: TokenType; value: TokenValue }>;
  themes: Record<string, Record<string, TokenValue>>;
}

// ------------------------------------------------------------------ schemas (plugin payloads)

const num = z.number().finite();
const snapshotValue = z.union([
  z.boolean(),
  num,
  z.string().max(1000),
  z.object({ r: num, g: num, b: num, a: num.optional() }),
  z.object({ type: z.literal('VARIABLE_ALIAS'), id: z.string().max(200) }),
]);
export const variablesSnapshot = z.object({
  collections: z
    .array(
      z.object({
        id: z.string().max(200),
        name: z.string().max(300),
        defaultModeId: z.string().max(200),
        modes: z
          .array(z.object({ modeId: z.string().max(200), name: z.string().max(200) }))
          .max(40),
        managed: z.boolean().optional(),
        variables: z
          .array(
            z.object({
              id: z.string().max(200),
              name: z.string().max(300),
              resolvedType: z.string().max(20),
              valuesByMode: z.record(z.string().max(200), snapshotValue),
              description: z.string().max(1000).optional(),
              tokenPath: z.string().max(200).optional(),
            }),
          )
          .max(5000),
      }),
    )
    .max(50),
}) satisfies z.ZodType<VariablesSnapshot>;

// ------------------------------------------------------------------ normalization

/** The syncable part of a design system (shadow tokens have no Figma variable type). */
export function dsToTokenSet(spec: DesignSystemSpec): TokenSet {
  const tokens: TokenSet['tokens'] = {};
  for (const [p, d] of Object.entries(spec.tokens))
    if (variableTypeFor(d.type)) tokens[p] = { type: d.type, value: d.value };
  const themes: TokenSet['themes'] = {};
  for (const [t, values] of Object.entries(spec.themes)) {
    themes[t] = {};
    for (const [p, v] of Object.entries(values)) if (tokens[p]) themes[t]![p] = v;
  }
  return { tokens, themes };
}

/** Pick the collection to sync: ours (managed), else by name, else the first. */
export function pickCollection(snap: VariablesSnapshot, name?: string): SnapshotCollection | null {
  return (
    snap.collections.find((c) => c.managed) ??
    (name ? snap.collections.find((c) => c.name === name) : undefined) ??
    snap.collections[0] ??
    null
  );
}

function inferType(path: string, resolved: string, existing?: TokenType): TokenType | null {
  if (resolved === 'COLOR') return 'color';
  if (resolved === 'STRING')
    return existing === 'fontFamily' || /font|family/i.test(path) ? 'fontFamily' : null;
  if (resolved !== 'FLOAT') return null;
  if (existing && existing !== 'color' && existing !== 'fontFamily' && existing !== 'shadow')
    return existing;
  const head = path.split('.')[0]!.toLowerCase();
  if (/radius|radii|rounded|corner/.test(head)) return 'radius';
  if (/weight/.test(path.toLowerCase())) return 'fontWeight';
  if (/leading|lineheight/.test(head)) return 'lineHeight';
  if (/^(text|fontsize|size-text|type)$/.test(head)) return 'fontSize';
  if (/^(space|spacing|gap|size|sizes|dimension|width|height|inset|padding|margin)$/.test(head))
    return 'dimension';
  return 'number';
}

function literal(type: TokenType, v: SnapshotValue): TokenValue | null {
  if (typeof v === 'object' && 'r' in v)
    return type === 'color' ? rgbaToCss({ ...v, a: v.a ?? 1 }) : null;
  if (typeof v === 'number') {
    if (type === 'dimension' || type === 'radius' || type === 'fontSize')
      return `${Math.round(v * 100) / 100}px`;
    if (type === 'fontWeight') return Math.min(900, Math.max(100, Math.round(v / 100) * 100));
    if (type === 'lineHeight' || type === 'number') return v;
    return null;
  }
  if (typeof v === 'string') return type === 'fontFamily' ? v : null;
  return null;
}

/** Figma variables -> TokenSet (with a report of what was skipped). */
export function snapshotToTokenSet(
  snap: VariablesSnapshot,
  opts: { existing?: DesignSystemSpec; collectionName?: string } = {},
): {
  set: TokenSet;
  report: ReturnType<Reporter['list']>;
  collection: SnapshotCollection | null;
  /** Theme names of every non-default mode (including modes with no overrides). */
  themes: string[];
} {
  const report = new Reporter();
  const set: TokenSet = { tokens: {}, themes: {} };
  const col = pickCollection(snap, opts.collectionName);
  if (!col) return { set, report: report.list(), collection: null, themes: [] };
  const pathById = new Map<string, string>();
  for (const v of col.variables) {
    const p =
      v.tokenPath && /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+)+$/.test(v.tokenPath)
        ? v.tokenPath
        : variableNameToTokenPath(v.name);
    if (p) pathById.set(v.id, p);
    else
      report.warn('Variable name can’t be a token path (use group/name); skipped', {
        subject: v.name,
      });
  }
  const modeTheme = new Map<string, string | null>();
  for (const m of col.modes) {
    if (m.modeId === col.defaultModeId) modeTheme.set(m.modeId, null);
    else {
      const t = themeName(m.name);
      if (t) modeTheme.set(m.modeId, t);
      else report.warn('Mode name can’t be a theme name; skipped', { subject: m.name });
    }
  }
  for (const v of col.variables) {
    const path = pathById.get(v.id);
    if (!path) continue;
    const type = inferType(path, v.resolvedType, opts.existing?.tokens[path]?.type);
    if (!type) {
      report.info(`${v.resolvedType} variables have no token type; skipped`, { subject: v.name });
      continue;
    }
    const conv = (val: SnapshotValue): TokenValue | null => {
      if (typeof val === 'object' && 'type' in val && val.type === 'VARIABLE_ALIAS') {
        const ref = pathById.get(val.id);
        return ref ? { ref } : null;
      }
      const lit = literal(type, val);
      return lit !== null && isValidTokenValue(type, lit) ? lit : null;
    };
    const baseVal = v.valuesByMode[col.defaultModeId];
    const base = baseVal === undefined ? null : conv(baseVal);
    if (base === null) {
      report.warn('Variable value isn’t a valid token value; skipped', { subject: v.name });
      continue;
    }
    set.tokens[path] = { type, value: base };
    for (const [modeId, val] of Object.entries(v.valuesByMode)) {
      const theme = modeTheme.get(modeId);
      if (!theme) continue;
      const tv = conv(val);
      if (tv === null || sameValue(type, tv, base)) continue;
      (set.themes[theme] ??= {})[path] = tv;
    }
  }
  for (const [p, d] of Object.entries(set.tokens)) {
    if (typeof d.value === 'object' && !set.tokens[d.value.ref]) {
      delete set.tokens[p];
      report.warn('Alias target not synced; skipped', { subject: p });
    }
  }
  const themes = [...new Set([...modeTheme.values()].filter((t): t is string => !!t))];
  return { set, report: report.list(), collection: col, themes };
}

// ------------------------------------------------------------------ comparison

export function sameValue(type: string, a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (typeof a === 'object' || typeof b === 'object') {
    return (
      typeof a === 'object' &&
      typeof b === 'object' &&
      (a as { ref?: string }).ref === (b as { ref?: string }).ref
    );
  }
  if (type === 'color') {
    const ca = parseCssColor(String(a));
    const cb = parseCssColor(String(b));
    return ca && cb ? sameColor(ca, cb) : a === b;
  }
  if (
    type === 'dimension' ||
    type === 'radius' ||
    type === 'fontSize' ||
    (type === 'lineHeight' && typeof a === 'string')
  ) {
    const pa = toPx(a);
    const pb = toPx(b);
    return pa !== null && pb !== null ? Math.abs(pa - pb) < 0.01 : a === b;
  }
  if (type === 'fontFamily')
    return primaryFamily(String(a)).toLowerCase() === primaryFamily(String(b)).toLowerCase();
  if (type === 'fontWeight') {
    const w = (x: unknown) => (x === 'bold' ? 700 : x === 'normal' ? 400 : x);
    return w(a) === w(b);
  }
  return a === b;
}

/** Resolved value of a token at a theme (theme override, else base). */
function at(set: TokenSet, path: string, theme: string | null): unknown {
  if (theme) {
    const t = set.themes[theme]?.[path];
    if (t !== undefined) return t;
  }
  return set.tokens[path]?.value;
}

/** Diff CrunchDesign (ours) against Figma (theirs) for one direction. */
export function diffTokenSets(
  ours: TokenSet,
  theirs: TokenSet,
  base: TokenSet | null,
  direction: 'pull' | 'push',
): Omit<TokenDiff, 'collection'> {
  const entries: TokenDiffEntry[] = [];
  const themes = new Set([...Object.keys(ours.themes), ...Object.keys(theirs.themes)]);
  const paths = new Set([...Object.keys(ours.tokens), ...Object.keys(theirs.tokens)]);
  for (const path of [...paths].sort()) {
    const type = (ours.tokens[path] ?? theirs.tokens[path])!.type;
    for (const theme of [null, ...[...themes].sort()]) {
      // Themes only matter where at least one side overrides the base.
      if (
        theme &&
        ours.themes[theme]?.[path] === undefined &&
        theirs.themes[theme]?.[path] === undefined
      )
        continue;
      const o = ours.tokens[path] ? at(ours, path, theme) : undefined;
      const t = theirs.tokens[path] ? at(theirs, path, theme) : undefined;
      if (sameValue(type, o, t)) continue;
      const b = base?.tokens[path] ? at(base, path, theme) : undefined;
      const key = `${theme ?? 'base'}:${path}`;
      const src = direction === 'pull' ? t : o;
      const dst = direction === 'pull' ? o : t;
      const entry: TokenDiffEntry = {
        key,
        path,
        theme,
        type,
        status: 'changed',
        ours: o,
        theirs: t,
        ...(b !== undefined ? { base: b } : {}),
      };
      const typeClash =
        !theme &&
        ours.tokens[path] &&
        theirs.tokens[path] &&
        ours.tokens[path]!.type !== theirs.tokens[path]!.type;
      if (typeClash) {
        entries.push({
          ...entry,
          status: 'conflict',
          reason: `Type differs (${ours.tokens[path]!.type} vs ${theirs.tokens[path]!.type})`,
        });
        continue;
      }
      // Base knowledge is per entry: tokens the sides never agreed on behave like a first sync.
      const known = !!base && b !== undefined;
      const srcChanged = known ? !sameValue(type, src, b) : true;
      const dstChanged = known ? !sameValue(type, dst, b) : true;
      if (known && !srcChanged) continue; // only the target changed: keep it
      if (dst === undefined) {
        // With a known base, the target deleted it after the last sync while the source changed it.
        if (known)
          entries.push({
            ...entry,
            status: 'conflict',
            reason: 'Deleted on one side, changed on the other',
          });
        else entries.push({ ...entry, status: 'added' });
        continue;
      }
      if (src === undefined) {
        if (known && dstChanged)
          entries.push({
            ...entry,
            status: 'conflict',
            reason: 'Deleted on one side, changed on the other',
          });
        else entries.push({ ...entry, status: 'removed' });
        continue;
      }
      if (!known)
        entries.push({
          ...entry,
          status: 'conflict',
          reason: 'Values differ and they were never synced',
        });
      else if (dstChanged)
        entries.push({
          ...entry,
          status: 'conflict',
          reason: 'Changed on both sides since the last sync',
        });
      else entries.push({ ...entry, status: 'changed' });
    }
  }
  const summary: Record<DiffStatus, number> = { added: 0, removed: 0, changed: 0, conflict: 0 };
  for (const e of entries) summary[e.status]++;
  return { direction, entries, summary, hasBase: !!base };
}

/**
 * The new sync base after an apply: everything both sides now agree on (theirs' values).
 * Tokens that still differ stay out of the base, so they keep showing as conflicts.
 */
export function agreedBase(ours: TokenSet, theirs: TokenSet): TokenSet {
  const out: TokenSet = { tokens: {}, themes: {} };
  for (const [p, t] of Object.entries(theirs.tokens)) {
    const o = ours.tokens[p];
    if (o && o.type === t.type && sameValue(t.type, o.value, t.value)) out.tokens[p] = t;
  }
  const themes = new Set([...Object.keys(ours.themes), ...Object.keys(theirs.themes)]);
  for (const theme of themes) {
    for (const p of Object.keys(out.tokens)) {
      const type = out.tokens[p]!.type;
      const ov = at(ours, p, theme);
      const tv = at(theirs, p, theme);
      if (!sameValue(type, ov, tv)) {
        delete out.tokens[p];
        continue;
      }
      if (theirs.themes[theme]?.[p] !== undefined) (out.themes[theme] ??= {})[p] = tv as TokenValue;
    }
  }
  return out;
}

// ------------------------------------------------------------------ applying

export class UnresolvedConflictError extends Error {
  override name = 'UnresolvedConflictError';
  constructor(public readonly keys: string[]) {
    super(
      `Choose a side for ${keys.length} conflict${keys.length === 1 ? '' : 's'} before applying`,
    );
  }
}

export interface Selection {
  /** Entry keys to apply. */
  selected: string[];
  /** Required for every selected conflict. */
  resolutions?: Record<string, Resolution>;
}

/** Changes to a DesignSystemSpec's tokens and themes. `null` deletes. */
export interface TokenPatch {
  tokens: Record<string, { type: TokenType; value: TokenValue } | null>;
  themes: Record<string, Record<string, TokenValue | null>>;
}

/**
 * The value each selected entry should end up with on the target side, or null to delete.
 * Entries resolved in favour of the target are dropped (nothing to do).
 */
function decisions(diff: Omit<TokenDiff, 'collection'>, sel: Selection) {
  const chosen = new Set(sel.selected);
  const unresolved: string[] = [];
  const out: { entry: TokenDiffEntry; value: unknown }[] = [];
  const winner: Resolution = diff.direction === 'pull' ? 'theirs' : 'ours';
  for (const e of diff.entries) {
    if (!chosen.has(e.key)) continue;
    let side: Resolution = winner;
    if (e.status === 'conflict') {
      const r = sel.resolutions?.[e.key];
      if (!r) {
        unresolved.push(e.key);
        continue;
      }
      side = r;
    }
    if (side !== winner) continue; // keep the target's value
    out.push({ entry: e, value: side === 'theirs' ? e.theirs : e.ours });
  }
  if (unresolved.length) throw new UnresolvedConflictError(unresolved);
  return out;
}

/** Pull: Figma -> DesignSystemSpec token patch (validated by applyTokenPatch). */
export function buildPullPatch(
  diff: Omit<TokenDiff, 'collection'>,
  theirs: TokenSet,
  sel: Selection,
): TokenPatch {
  if (diff.direction !== 'pull') throw new Error('Not a pull diff');
  const patch: TokenPatch = { tokens: {}, themes: {} };
  for (const { entry, value } of decisions(diff, sel)) {
    if (entry.theme) {
      // Figma has no override for this mode (its value equals the base): delete ours rather
      // than writing an explicit override that merely repeats the base value.
      const explicit = theirs.themes[entry.theme]?.[entry.path] !== undefined;
      (patch.themes[entry.theme] ??= {})[entry.path] =
        value === undefined || !explicit ? null : (value as TokenValue);
    } else if (value === undefined) patch.tokens[entry.path] = null;
    else
      patch.tokens[entry.path] = {
        type: theirs.tokens[entry.path]?.type ?? (entry.type as TokenType),
        value: value as TokenValue,
      };
  }
  return patch;
}

export class InvalidPatchError extends Error {
  override name = 'InvalidPatchError';
  constructor(public readonly issues: string[]) {
    super(`Token patch would make the design system invalid: ${issues.slice(0, 3).join('; ')}`);
  }
}

/** Apply a token patch to a DesignSystemSpec and validate the result (types, values, aliases). */
export function applyTokenPatch(spec: DesignSystemSpec, patch: TokenPatch): DesignSystemSpec {
  const next = structuredClone(spec);
  for (const [path, def] of Object.entries(patch.tokens)) {
    if (def === null) {
      delete next.tokens[path];
      for (const t of Object.values(next.themes)) delete t[path];
    } else
      next.tokens[path] = {
        ...(next.tokens[path]?.description ? { description: next.tokens[path]!.description } : {}),
        type: def.type,
        value: def.value,
      };
  }
  for (const [theme, values] of Object.entries(patch.themes)) {
    const t = (next.themes[theme] ??= {});
    for (const [path, v] of Object.entries(values)) {
      if (v === null) delete t[path];
      else t[path] = v;
    }
    if (!Object.keys(t).length) delete next.themes[theme];
  }
  const r = designSystemSpec.safeParse(next);
  if (!r.success)
    throw new InvalidPatchError(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  const issues: string[] = [];
  const refOk = (v: TokenValue, path: string) => {
    if (typeof v === 'object' && !r.data.tokens[v.ref])
      issues.push(`${path}: alias to missing token ${v.ref}`);
  };
  for (const [p, d] of Object.entries(r.data.tokens)) refOk(d.value, p);
  for (const [theme, values] of Object.entries(r.data.themes)) {
    for (const [p, v] of Object.entries(values)) {
      const def = r.data.tokens[p];
      if (!def) issues.push(`themes.${theme}.${p}: theme value for a missing token`);
      else if (typeof v !== 'object' && !isValidTokenValue(def.type, v))
        issues.push(`themes.${theme}.${p}: invalid ${def.type}`);
      else refOk(v, `themes.${theme}.${p}`);
    }
  }
  if (issues.length) throw new InvalidPatchError(issues);
  return r.data;
}

/**
 * Push: the variables to write and delete in Figma for the selected entries. Values for every mode
 * come from the merged result (Figma's current values with the selected CrunchDesign changes).
 */
export function buildPushVariables(
  diff: Omit<TokenDiff, 'collection'>,
  ours: TokenSet,
  theirs: TokenSet,
  sel: Selection,
  opts: {
    collectionName?: string;
    /** Theme names of every existing Figma mode, so modes without overrides still get values. */
    themes?: string[];
  } = {},
): { variables: VariablesSpec; remove: string[]; result: TokenSet } {
  if (diff.direction !== 'push') throw new Error('Not a push diff');
  const result: TokenSet = structuredClone(theirs);
  for (const t of opts.themes ?? []) result.themes[t] ??= {};
  const touched = new Set<string>();
  const remove: string[] = [];
  for (const { entry, value } of decisions(diff, sel)) {
    touched.add(entry.path);
    if (entry.theme) {
      const t = (result.themes[entry.theme] ??= {});
      // No explicit override on our side: the mode follows the base value.
      if (value === undefined || ours.themes[entry.theme]?.[entry.path] === undefined)
        delete t[entry.path];
      else t[entry.path] = value as TokenValue;
    } else if (value === undefined) {
      delete result.tokens[entry.path];
      for (const t of Object.values(result.themes)) delete t[entry.path];
      remove.push(entry.path);
    } else {
      result.tokens[entry.path] = {
        type: ours.tokens[entry.path]?.type ?? (entry.type as TokenType),
        value: value as TokenValue,
      };
    }
  }
  // Pull in alias targets so aliases resolve inside the collection.
  for (const p of [...touched]) {
    const v = result.tokens[p]?.value;
    if (v && typeof v === 'object' && !result.tokens[v.ref] && ours.tokens[v.ref]) {
      result.tokens[v.ref] = ours.tokens[v.ref]!;
      touched.add(v.ref);
    }
  }
  // The plugin maps the first mode to the collection's default mode and themes to modes by name.
  const spec = designSystemSpec.parse({
    schemaVersion: 1,
    tokens: result.tokens,
    themes: result.themes,
  });
  const variables = tokensToVariables(spec, {
    only: new Set([...touched].filter((p) => result.tokens[p])),
    collectionName: opts.collectionName,
  });
  return { variables, remove, result };
}
