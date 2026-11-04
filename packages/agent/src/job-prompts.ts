/** User prompts for background jobs, built from the validated job input (Story 5.5). */
import { toolsFor, type JobKind } from '@crunch/contracts';
import { stableStringify } from './stable';

/** Generic fallback: the kind and its input as JSON. Kind-specific prompts are in jobPrompt(). */
export function genericJobPrompt(kind: JobKind, input: unknown): string {
  return `Job: ${kind}\nInput:\n${stableStringify(input, 2)}`;
}

/** Tools a job's agent may call (MCP names without the prefix). */
export const jobToolNames = () => toolsFor('job').map((t) => t.name);
