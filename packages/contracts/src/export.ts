/**
 * Handoff bundle (Story 7.2): everything a code agent needs to implement a design in one
 * instruction. Producer: stream-collab-export (packages/handoff). Consumers: codegen job (7.3),
 * Figma export, external agents (Claude Code). Versioned: bump schemaVersion on breaking changes.
 */
import { designSystemSpec, frame, node } from '@crunch/doc-model';
import { z } from 'zod';

export const HANDOFF_SCHEMA_VERSION = 1 as const;

export const handoffBundle = z
  .object({
    schemaVersion: z.literal(HANDOFF_SCHEMA_VERSION),
    generatedAt: z.iso.datetime(),
    project: z
      .object({ id: z.uuid(), name: z.string(), description: z.string().nullable() })
      .strict(),
    designSystem: z
      .object({
        spec: designSystemSpec,
        /** Token path -> resolved literal (base theme), for agents that don't want to resolve aliases. */
        resolvedTokens: z.record(z.string(), z.union([z.string(), z.number()])),
        version: z.number().int().nullable(),
      })
      .strict(),
    frames: z.array(
      z
        .object({
          frame,
          /** Pre-order node list for this frame. */
          nodes: z.array(node),
          /** Static HTML (no annotations) for visual reference. */
          html: z.string(),
          /** Screenshot per breakpoint (asset URLs), when available. */
          screenshots: z.partialRecord(z.enum(['base', 'md', 'lg']), z.string()).default({}),
        })
        .strict(),
    ),
    /** Which design-system components are used where. */
    components: z.array(
      z.object({ componentId: z.string(), usages: z.array(z.string()) }).strict(),
    ),
    /** Design intent distilled from the conversation (summary plus notable decisions). */
    intent: z
      .object({ summary: z.string().max(10_000), notes: z.array(z.string().max(2000)).max(100) })
      .strict(),
    responsive: z
      .object({
        breakpoints: z.object({ md: z.number(), lg: z.number() }).strict(),
        approach: z.literal('mobile-first'),
      })
      .strict(),
  })
  .strict();
export type HandoffBundle = z.infer<typeof handoffBundle>;
