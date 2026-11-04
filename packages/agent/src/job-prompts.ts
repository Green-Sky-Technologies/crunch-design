/** User prompts for background jobs, built from the validated job input (Story 5.5). */
import { toolsFor, type JobInput, type JobKind } from '@crunch/contracts';
import type { DesignDoc } from '@crunch/doc-model';
import { outline } from './context';
import { stableStringify } from './stable';

/** Generic fallback: the kind and its input as JSON. */
export function genericJobPrompt(kind: JobKind, input: unknown): string {
  return `Job: ${kind}\nInput:\n${stableStringify(input, 2)}`;
}

/** Tools a job's agent may call (MCP names without the prefix). */
export const jobToolNames = () => toolsFor('job').map((t) => t.name);

export const GENERATION_KINDS = ['generate', 'redesign', 'alternatives'] as const;
export type GenerationKind = (typeof GENERATION_KINDS)[number];
export const isGenerationKind = (k: string): k is GenerationKind =>
  (GENERATION_KINDS as readonly string[]).includes(k);

const frameOutline = (doc: DesignDoc, frameId: string) =>
  doc.frames.some((f) => f.id === frameId)
    ? outline(doc, { frameId, maxDepth: 8 })
    : `(frame ${frameId} not found)`;

const FINISH =
  'When you are done, run_lint on what you built, fix real issues, then reply with a short summary that lists every frame you created or changed by name.';

/** Kind-specific instructions. `doc` gives the agent the current state of the frames involved. */
export function jobPrompt(kind: JobKind, rawInput: unknown, doc: DesignDoc | null): string {
  switch (kind) {
    case 'generate': {
      const input = rawInput as JobInput<'generate'>;
      const existing = doc?.frames.length
        ? `\n\nExisting frames (keep them; add new ones beside them):\n${doc.frames.map((f) => `- ${f.id} "${f.name}" width=${f.width}`).join('\n')}`
        : '';
      return `Create ${input.frameCount === 1 ? 'one new frame' : `${input.frameCount} new frames`} for this request:\n\n${input.prompt}${existing}\n\nBuild each frame with insert_frame (root first, then refine with patch_nodes), one frame at a time so the user sees progress. Use design-system tokens and components. ${FINISH}`;
    }
    case 'redesign': {
      const input = rawInput as JobInput<'redesign'>;
      const frames = doc
        ? input.frameIds.map((id) => frameOutline(doc, id)).join('\n\n')
        : input.frameIds.join(', ');
      return `Redesign these frames in place:\n\n${frames}\n\nRequest:\n${input.prompt}\n\nRead nodes with get_subtree before changing them. Restructure with patch_nodes (insertSubtree, moveNode, removeNode, setStyle, setProps); keep node ids where an element survives. Don't touch other frames. A snapshot was taken before you started, so the user can revert. ${FINISH}`;
    }
    case 'alternatives': {
      const input = rawInput as JobInput<'alternatives'>;
      const base = doc ? frameOutline(doc, input.frameId) : input.frameId;
      return `Create ${input.count} alternative designs of this frame as new sibling frames (do not modify the original):\n\n${base}\n\n${input.prompt ? `Direction:\n${input.prompt}\n\n` : ''}Name them "<original name> — Alt 1", "— Alt 2" and so on, with the same width as the original. Make each alternative meaningfully different in layout or visual approach while keeping the content. Use insert_frame for each one. ${FINISH}`;
    }
    default:
      return genericJobPrompt(kind, rawInput);
  }
}
