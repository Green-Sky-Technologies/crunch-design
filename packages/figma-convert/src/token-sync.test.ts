import { describe, expect, it } from 'vitest';
import { starterDesignSystem } from '@crunch/doc-model';
import type { VariablesSpec } from './plan';
import type { VariablesSnapshot } from './sync-types';
import {
  applyTokenPatch,
  buildPullPatch,
  buildPushVariables,
  diffTokenSets,
  dsToTokenSet,
  InvalidPatchError,
  snapshotToTokenSet,
  UnresolvedConflictError,
  variablesSnapshot,
  type TokenSet,
} from './token-sync';
import { tokensToVariables } from './variables';

const ds = starterDesignSystem();

/** Fake "Figma file": the variables a push would create, read back as the plugin would. */
function snapshotFrom(spec: VariablesSpec, defaultName = 'Light'): VariablesSnapshot {
  const modes = spec.modes.map((m, i) => ({
    modeId: `1:${i}`,
    name: i === 0 ? defaultName : m[0]!.toUpperCase() + m.slice(1),
  }));
  const idOf = new Map(spec.variables.map((v, i) => [v.path, `VariableID:9:${i}`]));
  return {
    collections: [
      {
        id: 'VariableCollectionId:1:1',
        name: spec.collectionName,
        defaultModeId: '1:0',
        modes,
        managed: true,
        variables: spec.variables.map((v) => ({
          id: idOf.get(v.path)!,
          name: v.name,
          resolvedType: v.type,
          valuesByMode: Object.fromEntries(
            spec.modes.map((m, i) => {
              const val = v.valuesByMode[m]!;
              return [
                `1:${i}`,
                typeof val === 'object' && 'alias' in val
                  ? { type: 'VARIABLE_ALIAS' as const, id: idOf.get(val.alias)! }
                  : val,
              ];
            }),
          ),
        })),
      },
    ],
  };
}

const figmaOf = (snap: VariablesSnapshot): TokenSet =>
  snapshotToTokenSet(snap, { existing: ds }).set;
const variable = (snap: VariablesSnapshot, name: string) =>
  snap.collections[0]!.variables.find((v) => v.name === name)!;

describe('token sync', () => {
  const pushed = snapshotFrom(tokensToVariables(ds));

  it('a freshly pushed collection round-trips with no differences (light/dark -> base/dark theme)', () => {
    expect(variablesSnapshot.safeParse(pushed).success).toBe(true);
    const theirs = figmaOf(pushed);
    expect(theirs.tokens['space.4']).toEqual({ type: 'dimension', value: '16px' });
    expect(theirs.themes.dark?.['color.background']).toBe('#0b0b0f');
    const diff = diffTokenSets(dsToTokenSet(ds), theirs, null, 'pull');
    expect(diff.entries).toEqual([]);
  });

  it('without a previous sync, differing values are conflicts that must be resolved explicitly', () => {
    const snap = structuredClone(pushed);
    variable(snap, 'color/primary').valuesByMode['1:0'] = { r: 1, g: 0, b: 0, a: 1 };
    const theirs = figmaOf(snap);
    const diff = diffTokenSets(dsToTokenSet(ds), theirs, null, 'pull');
    expect(diff.entries).toEqual([
      expect.objectContaining({
        key: 'base:color.primary',
        status: 'conflict',
        ours: '#4f46e5',
        theirs: '#ff0000',
      }),
    ]);
    expect(() => buildPullPatch(diff, theirs, { selected: ['base:color.primary'] })).toThrow(
      UnresolvedConflictError,
    );
    // Unselected conflicts are simply not applied.
    expect(buildPullPatch(diff, theirs, { selected: [] })).toEqual({ tokens: {}, themes: {} });
    const keep = buildPullPatch(diff, theirs, {
      selected: ['base:color.primary'],
      resolutions: { 'base:color.primary': 'ours' },
    });
    expect(keep.tokens).toEqual({});
    const take = buildPullPatch(diff, theirs, {
      selected: ['base:color.primary'],
      resolutions: { 'base:color.primary': 'theirs' },
    });
    const next = applyTokenPatch(ds, take);
    expect(next.tokens['color.primary']!.value).toBe('#ff0000');
  });

  it('with a base, classifies added / removed / changed / conflict and ignores target-only edits', () => {
    const base = dsToTokenSet(ds);
    const ours = structuredClone(base);
    ours.tokens['color.muted'] = { type: 'color', value: '#777777' }; // DS-only edit
    ours.tokens['color.text'] = { type: 'color', value: '#111111' }; // both edited
    const snap = structuredClone(pushed);
    variable(snap, 'color/primary').valuesByMode['1:0'] = { r: 1, g: 0, b: 0, a: 1 };
    variable(snap, 'color/text').valuesByMode['1:0'] = { r: 0.2, g: 0.2, b: 0.2, a: 1 };
    variable(snap, 'color/background').valuesByMode['1:1'] = { r: 0, g: 0, b: 0, a: 1 }; // dark mode
    snap.collections[0]!.variables = snap.collections[0]!.variables.filter(
      (v) => v.name !== 'color/accent',
    );
    snap.collections[0]!.variables.push({
      id: 'VariableID:10:1',
      name: 'color/success',
      resolvedType: 'COLOR',
      valuesByMode: { '1:0': { r: 0, g: 1, b: 0, a: 1 }, '1:1': { r: 0, g: 1, b: 0, a: 1 } },
    });
    const theirs = figmaOf(snap);

    const pull = diffTokenSets(ours, theirs, base, 'pull');
    const byKey = Object.fromEntries(pull.entries.map((e) => [e.key, e.status]));
    expect(byKey).toEqual({
      'base:color.primary': 'changed',
      'base:color.text': 'conflict',
      'base:color.accent': 'removed',
      'base:color.success': 'added',
      'dark:color.background': 'changed',
    });
    expect(pull.summary).toEqual({ added: 1, removed: 1, changed: 2, conflict: 1 });

    const patch = buildPullPatch(pull, theirs, {
      selected: [
        'base:color.primary',
        'base:color.success',
        'base:color.accent',
        'dark:color.background',
      ],
    });
    expect(patch.tokens['color.accent']).toBeNull();
    const next = applyTokenPatch(ds, patch);
    expect(next.tokens['color.success']).toEqual({ type: 'color', value: '#00ff00' });
    expect(next.tokens['color.accent']).toBeUndefined();
    expect(next.themes.dark?.['color.background']).toBe('#000000');
    expect(next.tokens['color.muted']!.value).toBe('#6b6b70'); // untouched DS value (pull patch applies to ds)

    const push = diffTokenSets(ours, theirs, base, 'push');
    expect(Object.fromEntries(push.entries.map((e) => [e.key, e.status]))).toEqual({
      'base:color.muted': 'changed',
      'base:color.text': 'conflict',
      // Only in Figma and never synced: listed as an (opt-in) removal, not hidden.
      'base:color.success': 'removed',
    });
    const { variables, remove } = buildPushVariables(push, ours, theirs, {
      selected: ['base:color.muted', 'base:color.text'],
      resolutions: { 'base:color.text': 'ours' },
    });
    expect(remove).toEqual([]);
    expect(variables.variables.map((v) => v.path).sort()).toEqual(['color.muted', 'color.text']);
    const muted = variables.variables.find((v) => v.path === 'color.muted')!;
    expect(Object.keys(muted.valuesByMode).sort()).toEqual(['dark', 'light']);
  });

  it('rejects patches that would make the design system invalid', () => {
    expect(() =>
      applyTokenPatch(ds, {
        tokens: { 'color.link': { type: 'color', value: { ref: 'color.missing' } } },
        themes: {},
      }),
    ).toThrow(InvalidPatchError);
    expect(() =>
      applyTokenPatch(ds, { tokens: {}, themes: { dark: { 'space.4': 'red' } } }),
    ).toThrow(InvalidPatchError);
  });

  it('infers token types from names and maps aliases', () => {
    const snap: VariablesSnapshot = {
      collections: [
        {
          id: 'c',
          name: 'Brand',
          defaultModeId: 'm1',
          modes: [
            { modeId: 'm1', name: 'Mode 1' },
            { modeId: 'm2', name: 'Dark Mode' },
          ],
          variables: [
            {
              id: 'a',
              name: 'radius/card',
              resolvedType: 'FLOAT',
              valuesByMode: { m1: 12, m2: 12 },
            },
            {
              id: 'b',
              name: 'font/heading',
              resolvedType: 'STRING',
              valuesByMode: { m1: 'Inter', m2: 'Inter' },
            },
            {
              id: 'c',
              name: 'brand/main',
              resolvedType: 'COLOR',
              valuesByMode: { m1: { r: 0, g: 0, b: 1, a: 1 }, m2: { r: 1, g: 1, b: 1, a: 1 } },
            },
            {
              id: 'd',
              name: 'color/link',
              resolvedType: 'COLOR',
              valuesByMode: {
                m1: { type: 'VARIABLE_ALIAS', id: 'c' },
                m2: { type: 'VARIABLE_ALIAS', id: 'c' },
              },
            },
            {
              id: 'e',
              name: 'flag/beta',
              resolvedType: 'BOOLEAN',
              valuesByMode: { m1: true, m2: true },
            },
          ],
        },
      ],
    };
    const { set, report } = snapshotToTokenSet(snap);
    expect(set.tokens).toEqual({
      'radius.card': { type: 'radius', value: '12px' },
      'font.heading': { type: 'fontFamily', value: 'Inter' },
      'brand.main': { type: 'color', value: '#0000ff' },
      'color.link': { type: 'color', value: { ref: 'brand.main' } },
    });
    expect(set.themes).toEqual({ 'dark-mode': { 'brand.main': '#ffffff' } });
    expect(report.some((r) => r.subject === 'flag/beta')).toBe(true);
  });
});
