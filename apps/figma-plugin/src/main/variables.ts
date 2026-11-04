/**
 * Upsert Figma variables from a plan.
 *
 * Two policies:
 * - 'create-missing' (design push, Story 8.2): create variables that don't exist and bind to ones
 *   that do, but never change an existing variable. Existing variables whose values differ are
 *   reported so the user can review them in the Tokens tab, where the 8.4 diff and conflict
 *   rules apply.
 * - 'overwrite' (token sync push, Story 8.4): write the values the user reviewed and selected.
 *
 * The Figma variables API is injected (defaults to `figma.variables`) so this is testable.
 */
import {
  modeKey,
  PLUGIN_TOKEN_KEY,
  sameVariableValue,
  type FigmaVariableValue,
  type VariablesSpec,
} from '@crunch/figma-convert/plugin';
import type { Note } from './note';

export const COLLECTION_KEY = 'cd:collection';

export type VariablesApi = Pick<
  PluginAPI['variables'],
  | 'getLocalVariableCollectionsAsync'
  | 'getLocalVariablesAsync'
  | 'createVariableCollection'
  | 'createVariable'
  | 'createVariableAlias'
>;

export interface UpsertResult {
  byPath: Map<string, Variable>;
  collectionId: string;
  /** Normalized mode name -> Figma mode id. */
  modes: Record<string, string>;
  created: number;
  updated: number;
  /** Token paths of existing variables whose values differ and were left alone. */
  differs: string[];
}

export interface UpsertOptions {
  remove?: string[];
  policy?: 'overwrite' | 'create-missing';
  api?: VariablesApi;
}

export async function upsertVariables(
  spec: VariablesSpec,
  note: Note,
  opts: UpsertOptions = {},
): Promise<UpsertResult> {
  const api = opts.api ?? figma.variables;
  const policy = opts.policy ?? 'overwrite';
  const all = await api.getLocalVariableCollectionsAsync();
  let col =
    all.find((c) => c.getPluginData(COLLECTION_KEY) === '1') ??
    all.find((c) => c.name === spec.collectionName) ??
    null;
  const newCollection = !col;
  if (!col) {
    col = api.createVariableCollection(spec.collectionName);
    col.renameMode(col.defaultModeId, spec.modes[0]!);
  }
  col.setPluginData(COLLECTION_KEY, '1');

  // The first spec mode is always the collection's default mode (base tokens). Other modes are
  // matched with the same normalization the server uses for theme names ("Dark Mode" = dark-mode).
  const modes: Record<string, string> = { [modeKey(spec.modes[0]!)]: col.defaultModeId };
  for (const m of col.modes)
    if (m.modeId !== col.defaultModeId) modes[modeKey(m.name)] ??= m.modeId;
  const modeId = (name: string) => modes[modeKey(name)];
  for (const name of spec.modes.slice(1)) {
    if (modeId(name)) continue;
    if (policy === 'create-missing' && !newCollection) {
      note(
        'info',
        `The "${name}" mode isn't in this Figma collection; add it with Tokens → Push`,
        name,
      );
      continue;
    }
    try {
      modes[modeKey(name)] = col.addMode(name);
    } catch {
      note(
        'warning',
        `Couldn't add the "${name}" mode (your Figma plan may limit modes); skipped its values`,
        name,
      );
    }
  }
  const covered = new Set(spec.modes.map((m) => modeId(m)).filter((x): x is string => !!x));
  const allModeIds = col.modes.map((m) => m.modeId);

  const existing = (await api.getLocalVariablesAsync()).filter(
    (v) => v.variableCollectionId === col.id,
  );
  const byPath = new Map<string, Variable>();
  for (const v of existing) {
    const p = v.getPluginData(PLUGIN_TOKEN_KEY);
    if (p && !byPath.has(p)) byPath.set(p, v);
  }
  const byName = new Map(existing.map((v) => [v.name, v]));

  let created = 0;
  let updated = 0;
  const fresh = new Set<string>();
  const differs: string[] = [];
  for (const vs of spec.variables) {
    let v = byPath.get(vs.path) ?? byName.get(vs.name);
    if (v && v.resolvedType !== vs.type) {
      note(
        'error',
        `Variable "${v.name}" is a ${v.resolvedType} in Figma but the token is ${vs.type}; skipped`,
        vs.path,
      );
      byPath.delete(vs.path);
      continue;
    }
    if (!v) {
      v = api.createVariable(vs.name, col, vs.type);
      v.setPluginData(PLUGIN_TOKEN_KEY, vs.path);
      if (vs.description !== undefined) v.description = vs.description;
      fresh.add(vs.path);
      created++;
    } else if (policy === 'overwrite') {
      updated++;
      if (v.name !== vs.name) v.name = vs.name;
      v.setPluginData(PLUGIN_TOKEN_KEY, vs.path);
      if (vs.description !== undefined) v.description = vs.description;
    }
    byPath.set(vs.path, v);
  }

  const toFigma = (
    value: VariablesSpec['variables'][number]['valuesByMode'][string],
    path: string,
  ) => {
    if (typeof value === 'object' && 'alias' in value) {
      const target = byPath.get(value.alias);
      if (!target) {
        note('warning', `Alias target "${value.alias}" missing; value skipped`, path);
        return null;
      }
      return api.createVariableAlias(target);
    }
    return value as VariableValue;
  };

  // Values second, so aliases can point at variables created in this pass.
  for (const vs of spec.variables) {
    const v = byPath.get(vs.path);
    if (!v || v.resolvedType !== vs.type) continue;
    if (policy === 'create-missing' && !fresh.has(vs.path)) {
      const same = Object.entries(vs.valuesByMode).every(([mode, value]) => {
        const id = modeId(mode);
        return (
          !id ||
          sameVariableValue(
            value,
            v.valuesByMode[id] as FigmaVariableValue | undefined,
            (p) => byPath.get(p)?.id,
          )
        );
      });
      if (!same) differs.push(vs.path);
      continue;
    }
    try {
      for (const [mode, value] of Object.entries(vs.valuesByMode)) {
        const id = modeId(mode);
        if (!id) continue;
        const val = toFigma(value, vs.path);
        if (val !== null) v.setValueForMode(id, val);
      }
      // Modes the plan doesn't mention (e.g. a Figma-only mode) follow the base value.
      const baseValue = vs.valuesByMode[spec.modes[0]!];
      if (baseValue !== undefined) {
        const val = toFigma(baseValue, vs.path);
        if (val !== null)
          for (const id of allModeIds) if (!covered.has(id)) v.setValueForMode(id, val);
      }
    } catch (e) {
      note('error', `Couldn't set values: ${e instanceof Error ? e.message : String(e)}`, vs.path);
    }
  }
  for (const path of differs) {
    note(
      'warning',
      'Figma variable differs from the design system and was not changed; review it in the Tokens tab',
      path,
    );
  }

  for (const path of opts.remove ?? []) {
    const v = byPath.get(path);
    if (v) {
      v.remove();
      byPath.delete(path);
    }
  }
  return { byPath, collectionId: col.id, modes, created, updated, differs };
}
