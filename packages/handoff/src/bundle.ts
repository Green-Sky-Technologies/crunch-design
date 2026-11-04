/**
 * Handoff bundle builder (Story 7.2). Produces exactly the `handoffBundle` contract from
 * @crunch/contracts (validated before returning), so codegen (7.3), Figma export and external
 * agents can implement a design from one file: "implement handoff.json".
 *
 * Deterministic: no LLM. The intent summary is assembled from the project description,
 * named-version notes and agent conversation titles; the agent stream may enrich it later.
 */
import { HANDOFF_SCHEMA_VERSION, handoffBundle, type HandoffBundle } from '@crunch/contracts';
import {
  isValidTokenValue,
  resolveToken,
  type DesignDoc,
  type DesignSystemSpec,
  type Node,
} from '@crunch/doc-model';
import { z } from 'zod';
import { exportHtml, resolveFrameIds } from './html';

export interface IntentSources {
  projectName: string;
  projectDescription: string | null;
  /** Named versions, newest first. */
  versions?: { name: string | null; description: string | null }[];
  /** Agent conversation titles, newest first. */
  conversationTitles?: (string | null)[];
}

const MAX_SUMMARY = 10_000;
const MAX_NOTE = 2000;
const MAX_NOTES = 100;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Deterministic design-intent summary (no LLM). */
export function summarizeIntent(src: IntentSources, doc: DesignDoc): HandoffBundle['intent'] {
  const frames = doc.frames.map((f) => `${f.name} (${f.width}px)`);
  const parts = [
    src.projectDescription?.trim() || `Design for “${src.projectName}”.`,
    frames.length
      ? `${frames.length} frame${frames.length === 1 ? '' : 's'}: ${frames.join(', ')}.`
      : 'No frames yet.',
  ];
  const notes: string[] = [];
  for (const v of src.versions ?? []) {
    if (!v.name && !v.description) continue;
    const d = v.description?.trim();
    notes.push(clip(`Version “${v.name ?? 'Untitled'}”${d ? `: ${d}` : ''}`, MAX_NOTE));
  }
  for (const t of src.conversationTitles ?? []) {
    if (t?.trim()) notes.push(clip(`Agent conversation: ${t.trim()}`, MAX_NOTE));
  }
  return { summary: clip(parts.join('\n\n'), MAX_SUMMARY), notes: notes.slice(0, MAX_NOTES) };
}

/** Pre-order node list for a frame's tree. */
export function frameNodes(doc: DesignDoc, rootId: string): Node[] {
  const out: Node[] = [];
  const visit = (id: string, depth: number) => {
    const n = doc.nodes[id];
    if (!n || depth > 200) return;
    out.push(n);
    for (const c of n.children) visit(c, depth + 1);
  };
  visit(rootId, 0);
  return out;
}

/** Token path -> literal value (base theme, aliases followed, valid doc overrides applied). */
export function resolveTokens(
  ds: DesignSystemSpec,
  overrides: Record<string, string | number> = {},
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const path of Object.keys(ds.tokens).sort()) {
    const def = ds.tokens[path]!;
    const o = overrides[path];
    if (o !== undefined && isValidTokenValue(def.type, o)) {
      out[path] = o;
      continue;
    }
    try {
      out[path] = resolveToken(ds.tokens, path);
    } catch {
      // alias to an unknown token: omit (the renderer warns about it too)
    }
  }
  return out;
}

export interface BuildHandoffInput {
  project: { id: string; name: string; description: string | null };
  doc: DesignDoc;
  designSystem: { spec: DesignSystemSpec; version: number | null };
  intent: IntentSources | HandoffBundle['intent'];
  frameIds?: string[];
  /** Screenshot asset URLs per frame and breakpoint, when a screenshot service provides them. */
  screenshots?: Record<string, Partial<Record<'base' | 'md' | 'lg', string>>>;
  generatedAt?: Date;
}

export function buildHandoffBundle(input: BuildHandoffInput): HandoffBundle {
  const { doc, designSystem } = input;
  const ds = designSystem.spec;
  const frameIds = resolveFrameIds(doc, input.frameIds);
  const frames = frameIds.map((id) => {
    const frame = doc.frames.find((f) => f.id === id)!;
    return {
      frame,
      nodes: frameNodes(doc, frame.rootNodeId),
      html: exportHtml(doc, ds, { frameIds: [id], title: frame.name }).html,
      screenshots: input.screenshots?.[id] ?? {},
    };
  });

  const usage = new Map<string, string[]>();
  for (const f of frames)
    for (const n of f.nodes)
      if (n.type === 'instance') {
        const list = usage.get(n.componentRef.componentId) ?? [];
        list.push(n.id);
        usage.set(n.componentRef.componentId, list);
      }
  const components = [...usage.keys()]
    .sort()
    .map((componentId) => ({ componentId, usages: usage.get(componentId)! }));

  const intent = 'summary' in input.intent ? input.intent : summarizeIntent(input.intent, doc);

  const bundle = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    project: {
      id: input.project.id,
      name: input.project.name,
      description: input.project.description,
    },
    designSystem: {
      spec: ds,
      resolvedTokens: resolveTokens(ds, doc.tokenOverrides),
      version: designSystem.version,
    },
    frames,
    components,
    intent,
    responsive: {
      breakpoints: { md: ds.breakpoints.md, lg: ds.breakpoints.lg },
      approach: 'mobile-first' as const,
    },
  };
  // Never ship a bundle that doesn't match the contract.
  return handoffBundle.parse(bundle);
}

/** JSON Schema for the bundle (documented schema shipped next to handoff.json). */
export function handoffJsonSchema(): unknown {
  return z.toJSONSchema(handoffBundle, { unrepresentable: 'any', io: 'output' });
}

/** Human/agent instructions shipped as HANDOFF.md in the handoff ZIP. */
export const HANDOFF_README = `# Design handoff

This folder is a CrunchDesign handoff bundle. To implement the design, give your coding agent
one instruction: **"Implement handoff.json."**

## Files
- \`handoff.json\`: the bundle (schemaVersion ${HANDOFF_SCHEMA_VERSION}); \`handoff.schema.json\` is its JSON Schema.
- \`index.html\`, \`frames/*.html\`: static reference renderings (open in a browser).
- \`assets/\`: bundled images, when available.

## handoff.json
- \`project\`: id, name, description.
- \`designSystem.spec\`: tokens (with aliases \`{ "ref": "path" }\`), themes, breakpoints, components,
  brand guidelines. \`designSystem.resolvedTokens\` maps every token path to its literal value.
  Token path \`color.primary\` is the CSS variable \`--color-primary\` in the HTML.
- \`frames[]\`: \`frame\` (name, canvas width/height), \`nodes\` (pre-order; \`parentId\`/\`children\`
  give the tree), and \`html\` (static rendering without editor annotations).
  - Node \`style\` is per breakpoint: \`base\` applies everywhere, \`md\`/\`lg\` override at
    \`responsive.breakpoints\` and up (mobile-first, like Tailwind's \`md:\`/\`lg:\` prefixes).
  - A style value is a literal or \`{ "token": "path" }\`: prefer the token in code.
  - \`positioning: "absolute"\` nodes are positioned against their parent; everything else is flow
    (flex/grid) layout.
  - \`type: "instance"\` nodes render a design-system component (\`componentRef\`, \`props.values\`).
- \`components[]\`: which design-system components are used, and by which node ids.
- \`intent\`: what the design is for, plus notable decisions (named versions, conversations).
- \`responsive\`: breakpoint widths (\`md\`, \`lg\`); the approach is mobile-first.

## Fidelity
Match the reference HTML at each breakpoint. Use semantic elements (\`tag\` on box/text nodes),
keep \`ariaLabel\`/\`role\`/\`alt\`, and map tokens to your theme (e.g. a Tailwind config).
`;
