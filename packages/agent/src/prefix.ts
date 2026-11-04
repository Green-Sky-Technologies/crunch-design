/**
 * The cacheable prompt prefix (SPEC §2.2, Story 5.11): tools, then the system prompt, then the
 * active design system. All three are byte-stable for a given runtime and design system:
 * static text, tools sorted by name, design system serialized with sorted keys. Nothing
 * per-request (time, ids, user names, the document) goes here; that lives in the user turn.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { AgentRuntime } from '@crunch/contracts';
import type { DesignSystemSpec } from '@crunch/doc-model';
import { z } from 'zod';
import { contractToolDefs, jsonSchemaFor, type JsonToolDef } from './tool-defs';
import { stableStringify } from './stable';

export type CacheTtl = '5m' | '1h';

/**
 * TTL for the tools + system + design-system prefix (ADR 0002): 1h by default, so members who
 * pause 5–60 minutes between prompts still hit the cache. AGENT_PREFIX_CACHE_TTL=5m switches it
 * for measurement.
 */
export function prefixCacheTtl(env: Record<string, string | undefined> = process.env): CacheTtl {
  return env.AGENT_PREFIX_CACHE_TTL === '5m' ? '5m' : '1h';
}

/** Interactive-only tool: hand a too-big request over to a generation job (Story 5.4 AC). */
export const SUGGEST_JOB_TOOL = 'suggest_generation_job';
export const suggestJobInput = z
  .object({
    kind: z.enum(['generate', 'redesign', 'alternatives']),
    prompt: z.string().min(1).max(4000),
    frameIds: z.array(z.string()).max(20).optional(),
    count: z.number().int().min(2).max(5).optional(),
    reason: z.string().max(400),
  })
  .strict();
export type JobSuggestion = z.infer<typeof suggestJobInput>;

const suggestJobDef: JsonToolDef = {
  name: SUGGEST_JOB_TOOL,
  description:
    'Offer the user a background generation job instead of editing now. Use it when the request needs new pages or frames, a redesign of whole frames, or several alternatives. The user decides whether to start it.',
  input_schema: jsonSchemaFor(suggestJobInput),
};

const SYSTEM_COMMON = `You are CrunchDesign's design agent. You edit a structured design document (DesignDoc), not HTML.

The document has frames (artboards), each with a root node. Nodes are box, text, image, svg or instance (a design-system component). Each node has responsive styles per breakpoint: base (mobile-first), md and lg. Style values are either literals or design-system token references like {"token":"color.primary"}.

How to work:
- Prefer tokens over literal values. Use the design system's components and guidelines.
- Change only what the request needs. Edit existing nodes with small setStyle, setProps, setNodeMeta and moveNode ops through patch_nodes. Never rebuild a subtree to change one property.
- Node ids are stable. Reuse ids from the context; new nodes need new ids in the form n_ followed by 6 to 32 letters or digits, and new frames f_ followed by the same.
- The latest <document> block in the conversation is the current state. Earlier blocks may be stale.
- When the user asks for something adjustable (density, roundness, scale), offer a slider with create_slider. Moving a slider never calls you.
- After editing, run_lint on the nodes you changed and fix real issues.
- Keep replies short: say what you changed in one or two sentences.`;

const SYSTEM_INTERACTIVE = `${SYSTEM_COMMON}

You are on the quick-edit path: small, targeted changes to existing frames. If the request needs new pages or frames, redesigning whole frames, or several alternatives, don't attempt it here: call ${SUGGEST_JOB_TOOL} and briefly tell the user why.`;

const SYSTEM_JOB = `${SYSTEM_COMMON}

You are running as a background generation job. Build frames incrementally with insert_frame (one frame per call, root node first, nodes in pre-order), then refine with patch_nodes. Alternatives are separate sibling frames. Finish with a short summary listing the frames you created.`;

export function systemPromptFor(runtime: AgentRuntime): string {
  return runtime === 'interactive' ? SYSTEM_INTERACTIVE : SYSTEM_JOB;
}

/** Deterministic design-system block. Large component node trees are summarized by id list. */
export function serializeDesignSystem(ds: DesignSystemSpec): string {
  const components = Object.fromEntries(
    Object.entries(ds.components).map(([id, c]) => [
      id,
      {
        name: c.name,
        description: c.description,
        props: c.props,
        variants: c.variants,
      },
    ]),
  );
  return `<design_system>\n${stableStringify({
    breakpoints: ds.breakpoints,
    components,
    guidelines: ds.guidelines,
    themes: ds.themes,
    tokens: ds.tokens,
  })}\n</design_system>`;
}

/** Tools for a runtime, sorted by name (cache-stable). */
export function toolsForPrefix(runtime: AgentRuntime): Anthropic.Tool[] {
  const defs = [...contractToolDefs(runtime)];
  if (runtime === 'interactive') defs.push(suggestJobDef);
  return defs
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(
      (d) =>
        ({
          name: d.name,
          description: d.description,
          input_schema: d.input_schema,
        }) as Anthropic.Tool,
    );
}

export interface Prefix {
  system: Anthropic.TextBlockParam[];
  tools: Anthropic.Tool[];
}

/**
 * Build the prefix. The cache breakpoint sits on the design-system block, which renders after
 * tools and the system prompt, so one entry covers all three.
 */
export function buildPrefix(
  runtime: AgentRuntime,
  ds: DesignSystemSpec,
  ttl: CacheTtl = '1h',
): Prefix {
  return {
    tools: toolsForPrefix(runtime),
    system: [
      { type: 'text', text: systemPromptFor(runtime) },
      {
        type: 'text',
        text: serializeDesignSystem(ds),
        cache_control: ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' },
      },
    ],
  };
}

/** The prefix exactly as it goes on the wire (tools render first), for stability tests. */
export const prefixBytes = (p: Prefix) => JSON.stringify({ tools: p.tools, system: p.system });
