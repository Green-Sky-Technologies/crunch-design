import { describe, expect, it } from 'vitest';
import type { VariablesSpec } from '@crunch/figma-convert/plugin';
import { fakeVariablesApi } from './fake-variables';
import { collector } from './note';
import { upsertVariables } from './variables';

const red = { r: 1, g: 0, b: 0, a: 1 };
const blue = { r: 0, g: 0, b: 1, a: 1 };

const spec = (over: Partial<VariablesSpec> = {}): VariablesSpec => ({
  collectionName: 'CrunchDesign tokens',
  modes: ['light', 'dark-mode'],
  variables: [
    {
      path: 'color.primary',
      name: 'color/primary',
      type: 'COLOR',
      valuesByMode: { light: red, 'dark-mode': red },
    },
    {
      path: 'space.4',
      name: 'space/4',
      type: 'FLOAT',
      valuesByMode: { light: 16, 'dark-mode': 16 },
    },
  ],
  ...over,
});

describe('upsertVariables', () => {
  it('matches existing modes by normalized name instead of adding duplicates', async () => {
    const f = fakeVariablesApi();
    const col = f.addCollection('CrunchDesign tokens', ['Light', 'Dark Mode']);
    const { note } = collector();
    await upsertVariables(spec(), note, { api: f.api });
    expect(col.modes.map((m) => m.name)).toEqual(['Light', 'Dark Mode']);
    const primary = f.variables.find((v) => v.name === 'color/primary')!;
    expect(Object.keys(primary.valuesByMode).sort()).toEqual(col.modes.map((m) => m.modeId).sort());
  });

  it('fills modes the plan does not mention with the base value', async () => {
    const f = fakeVariablesApi();
    const col = f.addCollection('CrunchDesign tokens', ['Light', 'Dark Mode', 'Print']);
    const { note } = collector();
    await upsertVariables(spec(), note, { api: f.api });
    const print = col.modes[2]!.modeId;
    expect(f.variables.find((v) => v.name === 'space/4')!.valuesByMode[print]).toBe(16);
  });

  it('design push (create-missing) never overwrites differing values and reports them', async () => {
    const f = fakeVariablesApi();
    const col = f.addCollection('CrunchDesign tokens', ['Light', 'Dark Mode']);
    const [light, dark] = col.modes.map((m) => m.modeId);
    const existing = f.addVariable(col, 'color/primary', 'COLOR', {
      [light!]: blue,
      [dark!]: blue,
    });
    const same = f.addVariable(col, 'space/4', 'FLOAT', { [light!]: 16, [dark!]: 16 });
    const { note, items } = collector();
    const r = await upsertVariables(
      spec({
        variables: [
          ...spec().variables,
          {
            path: 'color.new',
            name: 'color/new',
            type: 'COLOR',
            valuesByMode: { light: red, 'dark-mode': red },
          },
        ],
      }),
      note,
      { api: f.api, policy: 'create-missing' },
    );
    expect(existing.valuesByMode[light!]).toEqual(blue); // untouched
    expect(same.valuesByMode[light!]).toBe(16);
    expect(r.differs).toEqual(['color.primary']);
    expect(r.created).toBe(1);
    expect(r.byPath.get('color.primary')).toBe(existing); // still bound
    expect(items.some((i) => i.subject === 'color.primary' && /Tokens tab/.test(i.message))).toBe(
      true,
    );
  });

  it('create-missing does not add modes to an existing collection; overwrite writes values', async () => {
    const f = fakeVariablesApi();
    const col = f.addCollection('CrunchDesign tokens', ['Light']);
    const v = f.addVariable(col, 'color/primary', 'COLOR', { [col.modes[0]!.modeId]: blue });
    const { note } = collector();
    await upsertVariables(spec(), note, { api: f.api, policy: 'create-missing' });
    expect(col.modes).toHaveLength(1);
    await upsertVariables(spec(), note, { api: f.api, policy: 'overwrite' });
    expect(col.modes.map((m) => m.name)).toEqual(['Light', 'dark-mode']);
    expect(v.valuesByMode[col.modes[0]!.modeId]).toEqual(red);
  });
});
