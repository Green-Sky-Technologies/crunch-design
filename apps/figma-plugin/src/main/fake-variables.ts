/** A minimal in-memory stand-in for `figma.variables`, for tests. */
import type { VariablesApi } from './variables';

let seq = 0;

class FakeVariable {
  id = `VariableID:${++seq}`;
  description = '';
  valuesByMode: Record<string, unknown> = {};
  private data: Record<string, string> = {};
  removed = false;
  constructor(
    public name: string,
    public variableCollectionId: string,
    public resolvedType: string,
  ) {}
  getPluginData(k: string) {
    return this.data[k] ?? '';
  }
  setPluginData(k: string, v: string) {
    this.data[k] = v;
  }
  setValueForMode(modeId: string, v: unknown) {
    this.valuesByMode[modeId] = v;
  }
  remove() {
    this.removed = true;
  }
}

class FakeCollection {
  id = `VariableCollectionId:${++seq}`;
  modes: { modeId: string; name: string }[];
  defaultModeId: string;
  private data: Record<string, string> = {};
  constructor(
    public name: string,
    modeNames: string[] = ['Mode 1'],
  ) {
    this.modes = modeNames.map((n) => ({ modeId: `m${++seq}`, name: n }));
    this.defaultModeId = this.modes[0]!.modeId;
  }
  getPluginData(k: string) {
    return this.data[k] ?? '';
  }
  setPluginData(k: string, v: string) {
    this.data[k] = v;
  }
  renameMode(id: string, name: string) {
    this.modes.find((m) => m.modeId === id)!.name = name;
  }
  addMode(name: string) {
    const m = { modeId: `m${++seq}`, name };
    this.modes.push(m);
    return m.modeId;
  }
}

export function fakeVariablesApi() {
  const collections: FakeCollection[] = [];
  const variables: FakeVariable[] = [];
  const api = {
    getLocalVariableCollectionsAsync: async () => collections,
    getLocalVariablesAsync: async () => variables.filter((v) => !v.removed),
    createVariableCollection: (name: string) => {
      const c = new FakeCollection(name);
      collections.push(c);
      return c;
    },
    createVariable: (name: string, col: FakeCollection, type: string) => {
      const v = new FakeVariable(name, col.id, type);
      variables.push(v);
      return v;
    },
    createVariableAlias: (v: FakeVariable) => ({ type: 'VARIABLE_ALIAS', id: v.id }),
  };
  const addCollection = (name: string, modeNames: string[]) => {
    const c = new FakeCollection(name, modeNames);
    collections.push(c);
    return c;
  };
  return {
    api: api as unknown as VariablesApi,
    collections,
    variables,
    addCollection,
    addVariable: (
      col: FakeCollection,
      name: string,
      type: string,
      values: Record<string, unknown>,
    ) => {
      const v = new FakeVariable(name, col.id, type);
      v.valuesByMode = values;
      variables.push(v);
      return v;
    },
  };
}
