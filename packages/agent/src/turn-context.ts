/**
 * Per-turn document context (SPEC §2.3). It goes in the user message, after the cached prefix:
 * - chat: a compact outline of the doc plus full JSON for the selected nodes' subtrees;
 * - scoped "ask agent" (Story 5.7): only the target node's subtree and where it sits.
 */
import type { DesignDoc } from '@crunch/doc-model';
import { breadcrumb, outline, subtree } from './context';
import { stableStringify } from './stable';

export interface TurnContextInput {
  /** Selected nodes (chat with a selection). */
  selection?: string[];
  /** Focused frame for the outline. */
  frameId?: string | null;
  /** Scoped request: only this node's subtree is sent. */
  scopeNodeId?: string;
}

const MAX_SELECTED = 5;

export function buildTurnContext(doc: DesignDoc, input: TurnContextInput = {}): string {
  const parts: string[] = [];
  if (input.scopeNodeId) {
    const s = subtree(doc, input.scopeNodeId);
    if (!s) return '<document>\nThe target element no longer exists.\n</document>';
    parts.push(`Scope: only edit node ${input.scopeNodeId} and its descendants.`);
    parts.push(`Location: ${breadcrumb(doc, input.scopeNodeId)}`);
    parts.push(`<subtree>\n${stableStringify(s.nodes)}\n</subtree>`);
    return `<document>\n${parts.join('\n')}\n</document>`;
  }
  const big = Object.keys(doc.nodes).length > 300;
  parts.push(
    `<outline>\n${outline(doc, { frameId: input.frameId ?? undefined, maxDepth: big ? 3 : 6 })}\n</outline>`,
  );
  const selected = (input.selection ?? []).filter((id) => doc.nodes[id]).slice(0, MAX_SELECTED);
  if (selected.length) {
    parts.push(`Selected: ${selected.join(', ')}`);
    for (const id of selected) {
      const s = subtree(doc, id, { maxNodes: 150 });
      if (s) parts.push(`<subtree root="${id}">\n${stableStringify(s.nodes)}\n</subtree>`);
    }
  } else if (doc.frames.length) {
    parts.push('Nothing is selected. Use get_subtree to read the nodes you need before editing.');
  }
  return `<document>\n${parts.join('\n')}\n</document>`;
}

export interface DetectedJob {
  kind: 'generate' | 'redesign' | 'alternatives';
  count?: number;
}

const WORD_NUMBERS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };

/**
 * Cheap, deterministic pre-check for requests that obviously need a generation job, so we offer
 * one without spending tokens (SPEC §2.4). Conservative: anything unclear goes to the model,
 * which can still call suggest_generation_job.
 */
export function detectJobRequest(prompt: string): DetectedJob | null {
  const p = prompt.toLowerCase();
  const alt = p.match(
    /\b(?:show|give|make|create|generate)\b.*?\b(\d|two|three|four|five)\b\s+(?:\w+\s+)?(?:alternatives?|variations?|versions?|options|layouts)\b/,
  );
  if (alt) {
    const n = WORD_NUMBERS[alt[1]!] ?? Number(alt[1]);
    if (n >= 2 && n <= 5) return { kind: 'alternatives', count: n };
  }
  if (/\bredesign\b/.test(p)) return { kind: 'redesign' };
  if (
    /^(?:please\s+)?(?:design|generate|create|build|make)\s+(?:me\s+)?(?:a|an|the)\s+(?:new\s+|full\s+|complete\s+|whole\s+)?[\w\s-]{0,30}?\b(?:page|screen|site|website|landing|app|dashboard|flow)\b/.test(
      p.trim(),
    )
  )
    return { kind: 'generate' };
  return null;
}
