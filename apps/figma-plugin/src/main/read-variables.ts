/** Read the file's local variables into a snapshot for token sync (Story 8.4). */
import { PLUGIN_TOKEN_KEY, type VariablesSnapshot } from '@crunch/figma-convert/plugin';
import { COLLECTION_KEY } from './variables';

export async function readVariablesSnapshot(): Promise<VariablesSnapshot> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const variables = await figma.variables.getLocalVariablesAsync();
  return {
    collections: collections.slice(0, 50).map((c) => ({
      id: c.id,
      name: c.name,
      defaultModeId: c.defaultModeId,
      modes: c.modes.map((m) => ({ modeId: m.modeId, name: m.name })),
      managed: c.getPluginData(COLLECTION_KEY) === '1',
      variables: variables
        .filter((v) => v.variableCollectionId === c.id)
        .slice(0, 5000)
        .map((v) => {
          const valuesByMode: VariablesSnapshot['collections'][number]['variables'][number]['valuesByMode'] =
            {};
          for (const [modeId, val] of Object.entries(v.valuesByMode)) {
            if (
              typeof val === 'object' &&
              val !== null &&
              'type' in val &&
              val.type === 'VARIABLE_ALIAS'
            ) {
              valuesByMode[modeId] = { type: 'VARIABLE_ALIAS', id: val.id };
            } else if (typeof val === 'object' && val !== null && 'r' in val) {
              valuesByMode[modeId] = { r: val.r, g: val.g, b: val.b, a: 'a' in val ? val.a : 1 };
            } else if (
              typeof val === 'number' ||
              typeof val === 'string' ||
              typeof val === 'boolean'
            ) {
              valuesByMode[modeId] = val;
            }
          }
          const tokenPath = v.getPluginData(PLUGIN_TOKEN_KEY);
          return {
            id: v.id,
            name: v.name,
            resolvedType: v.resolvedType,
            valuesByMode,
            ...(v.description ? { description: v.description.slice(0, 1000) } : {}),
            ...(tokenPath ? { tokenPath } : {}),
          };
        }),
    })),
  };
}
