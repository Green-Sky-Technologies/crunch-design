/**
 * JSON-schema tool definitions for the model, generated from the shared Zod schemas.
 * Tools render first in the prompt, so this output must be byte-stable (sorted tools via
 * toolsFor(), sorted keys via stableStringify round-trip, no dynamic content).
 */
import { toolsFor, type AgentRuntime, type AgentToolDef } from '@crunch/contracts';
import { z } from 'zod';
import { sortKeys } from './stable';

export interface JsonToolDef {
  name: string;
  description: string;
  input_schema: { type: 'object'; [k: string]: unknown };
}

export function jsonSchemaFor(schema: z.ZodType): JsonToolDef['input_schema'] {
  const js = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    reused: 'ref',
  }) as Record<string, unknown>;
  delete js.$schema;
  return sortKeys(js) as JsonToolDef['input_schema'];
}

const cache = new Map<string, JsonToolDef[]>();

export function toJsonToolDef(t: AgentToolDef): JsonToolDef {
  return { name: t.name, description: t.description, input_schema: jsonSchemaFor(t.input) };
}

/** Contract tools for a runtime, in toolsFor() order, as JSON-schema definitions. */
export function contractToolDefs(runtime: AgentRuntime): JsonToolDef[] {
  let defs = cache.get(runtime);
  if (!defs) {
    defs = toolsFor(runtime).map(toJsonToolDef);
    cache.set(runtime, defs);
  }
  return defs;
}
