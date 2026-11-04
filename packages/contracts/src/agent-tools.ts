/**
 * Agent tool contract (Story 5.3). Names, descriptions and input schemas shared by both agent
 * runtimes (interactive Messages API path and Agent SDK sandbox jobs). The agent stream
 * implements the handlers; nobody else should redefine these shapes.
 *
 * Tool descriptions are part of the cached prompt prefix, so keep them byte-stable (no
 * timestamps or dynamic content).
 */
import { docOp, frame, node, slider } from '@crunch/doc-model';
import { z } from 'zod';

export const AGENT_RUNTIMES = ['interactive', 'job'] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];

export interface AgentToolDef<I extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: I;
  runtimes: readonly AgentRuntime[];
}

const def = <I extends z.ZodType>(d: AgentToolDef<I>) => d;
const both = AGENT_RUNTIMES;

export const AGENT_TOOLS = {
  get_outline: def({
    name: 'get_outline',
    description:
      'Compact outline of the document: frames and a node tree (id, type, tag, name, short text). Use it to find node ids before reading or editing.',
    input: z
      .object({
        frameId: z.string().optional(),
        maxDepth: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
    runtimes: both,
  }),
  get_subtree: def({
    name: 'get_subtree',
    description:
      'Full JSON for a node and its descendants (styles, props). Read before editing a region.',
    input: z
      .object({ nodeId: z.string(), maxDepth: z.number().int().min(1).max(50).optional() })
      .strict(),
    runtimes: both,
  }),
  patch_nodes: def({
    name: 'patch_nodes',
    description:
      'Apply DesignDoc ops as one undoable transaction. Change only what the request needs: surgical setStyle/setProps/moveNode ops, not whole-subtree rewrites.',
    input: z.object({ label: z.string().max(200), ops: z.array(docOp).min(1).max(2000) }).strict(),
    runtimes: both,
  }),
  insert_frame: def({
    name: 'insert_frame',
    description:
      'Create a new frame (artboard) with a node tree. `nodes` is pre-order; the first node is the root.',
    input: z
      .object({
        frame: frame.omit({ canvas: true }).extend({ canvas: frame.shape.canvas.optional() }),
        nodes: z.array(node).min(1).max(5000),
      })
      .strict(),
    runtimes: both,
  }),
  create_slider: def({
    name: 'create_slider',
    description:
      'Offer the user a slider bound to style props or tokens (e.g. "density" controls padding and gap). Moving it never calls the model.',
    input: z.object({ slider }).strict(),
    runtimes: both,
  }),
  get_design_system: def({
    name: 'get_design_system',
    description:
      'Design system tokens, components (props/variants) and brand guidelines. Prefer tokens over literal values.',
    input: z
      .object({ sections: z.array(z.enum(['tokens', 'components', 'guidelines'])).optional() })
      .strict(),
    runtimes: both,
  }),
  run_lint: def({
    name: 'run_lint',
    description:
      'Check nodes against the design system (literal values that should be tokens, spacing scale, contrast). Fix reported issues.',
    input: z.object({ nodeIds: z.array(z.string()).max(5000).optional() }).strict(),
    runtimes: both,
  }),
  screenshot_frame: def({
    name: 'screenshot_frame',
    description: 'Render a frame to an image to visually check your work.',
    input: z
      .object({ frameId: z.string(), breakpoint: z.enum(['base', 'md', 'lg']).optional() })
      .strict(),
    runtimes: ['job'],
  }),
  capture_url: def({
    name: 'capture_url',
    description: 'Capture a public web page (structure, styles, screenshot) as reference.',
    input: z.object({ url: z.url({ protocol: /^https?$/ }) }).strict(),
    runtimes: ['job'],
  }),
  get_figma_frame: def({
    name: 'get_figma_frame',
    description: 'Fetch a Figma frame (converted to DesignDoc nodes plus an image) as reference.',
    input: z.object({ fileKey: z.string().max(64), nodeId: z.string().max(64) }).strict(),
    runtimes: ['job'],
  }),
} as const;

export type AgentToolName = keyof typeof AGENT_TOOLS;
export type AgentToolInput<N extends AgentToolName> = z.infer<(typeof AGENT_TOOLS)[N]['input']>;

/** Tools available to a runtime, in a stable order (cache-friendly). */
export function toolsFor(runtime: AgentRuntime): AgentToolDef[] {
  return (Object.keys(AGENT_TOOLS) as AgentToolName[])
    .sort()
    .map((k) => AGENT_TOOLS[k] as AgentToolDef)
    .filter((t) => t.runtimes.includes(runtime));
}
