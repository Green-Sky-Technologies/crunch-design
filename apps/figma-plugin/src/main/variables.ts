/** Upsert Figma variables from a plan (push, Story 8.2; token sync, Story 8.4). */
import { PLUGIN_TOKEN_KEY, type VariablesSpec } from '@crunch/figma-convert/plugin';
import type { Note } from './note';

export const COLLECTION_KEY = 'cd:collection';

export interface UpsertResult {
  byPath: Map<string, Variable>;
  collectionId: string;
  /** Mode name -> Figma mode id. */
  modes: Record<string, string>;
  created: number;
  updated: number;
}

async function findCollection(name: string): Promise<VariableCollection | null> {
  const all = await figma.variables.getLocalVariableCollectionsAsync();
  return (
    all.find((c) => c.getPluginData(COLLECTION_KEY) === '1') ??
    all.find((c) => c.name === name) ??
    null
  );
}

export async function upsertVariables(
  spec: VariablesSpec,
  note: Note,
  opts: { remove?: string[] } = {},
): Promise<UpsertResult> {
  let col = await findCollection(spec.collectionName);
  if (!col) {
    col = figma.variables.createVariableCollection(spec.collectionName);
    col.renameMode(col.defaultModeId, spec.modes[0]!);
  }
  col.setPluginData(COLLECTION_KEY, '1');

  const modes: Record<string, string> = {};
  for (const m of col.modes) modes[m.name.toLowerCase()] = m.modeId;
  const modeId = (name: string) => modes[name.toLowerCase()];
  if (!modeId(spec.modes[0]!)) modes[spec.modes[0]!.toLowerCase()] = col.defaultModeId;
  for (const name of spec.modes.slice(1)) {
    if (modeId(name)) continue;
    try {
      modes[name.toLowerCase()] = col.addMode(name);
    } catch {
      note(
        'warning',
        `Couldn't add the "${name}" mode (your Figma plan may limit modes); skipped its values`,
        name,
      );
    }
  }

  const existing = (await figma.variables.getLocalVariablesAsync()).filter(
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
  for (const vs of spec.variables) {
    let v = byPath.get(vs.path) ?? byName.get(vs.name);
    if (v && v.resolvedType !== vs.type) {
      note(
        'error',
        `Variable "${v.name}" is a ${v.resolvedType} in Figma but the token is ${vs.type}; skipped`,
        vs.path,
      );
      continue;
    }
    if (!v) {
      v = figma.variables.createVariable(vs.name, col, vs.type);
      created++;
    } else {
      updated++;
      if (v.name !== vs.name) v.name = vs.name;
    }
    v.setPluginData(PLUGIN_TOKEN_KEY, vs.path);
    if (vs.description !== undefined) v.description = vs.description;
    byPath.set(vs.path, v);
  }

  // Values second, so aliases can point at variables created in this pass.
  for (const vs of spec.variables) {
    const v = byPath.get(vs.path);
    if (!v || v.resolvedType !== vs.type) continue;
    for (const [mode, value] of Object.entries(vs.valuesByMode)) {
      const id = modeId(mode);
      if (!id) continue;
      try {
        if (typeof value === 'object' && 'alias' in value) {
          const target = byPath.get(value.alias);
          if (!target) {
            note('warning', `Alias target "${value.alias}" missing; value skipped`, vs.path);
            continue;
          }
          v.setValueForMode(id, figma.variables.createVariableAlias(target));
        } else {
          v.setValueForMode(id, value as VariableValue);
        }
      } catch (e) {
        note(
          'error',
          `Couldn't set ${mode} value: ${e instanceof Error ? e.message : String(e)}`,
          vs.path,
        );
      }
    }
  }

  for (const path of opts.remove ?? []) {
    const v = byPath.get(path);
    if (v) {
      v.remove();
      byPath.delete(path);
    }
  }
  return { byPath, collectionId: col.id, modes, created, updated };
}
