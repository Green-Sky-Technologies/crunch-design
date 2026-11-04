/** Zod schemas and size limits for inbound plugin payloads (Epic 8). */
import { variablesSnapshot } from '@crunch/figma-convert';
import { z } from 'zod';

export const KB = 1024;
export const MB = 1024 * KB;

/** Figma file keys are short base62-ish strings; plugin-local file ids are `local:<uuid>`. */
export const figmaFileKey = z
  .string()
  .regex(/^(?:[A-Za-z0-9]{10,64}|local:[0-9a-f-]{36})$/, 'Invalid Figma file key');
/** Figma node ids: "1:2", "I1:2;3:4" (instance sublayers). */
export const figmaNodeId = z
  .string()
  .regex(/^I?\d+[:-]\d+(?:;\d+[:-]\d+)*$/, 'Invalid Figma node id');

export const reportItem = z
  .object({
    severity: z.enum(['info', 'warning', 'error']),
    nodeId: z.string().max(80).optional(),
    nodeName: z.string().max(200).optional(),
    subject: z.string().max(200).optional(),
    message: z.string().max(500),
    count: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();
export const report = z.array(reportItem).max(1000);

export const PUSH_PLAN_MAX_BYTES = 16 * KB;
export const pushPlanRequest = z
  .object({
    frameIds: z.array(z.string().max(40)).min(1).max(200).optional(),
    width: z.number().int().min(160).max(4096).optional(),
    variables: z.boolean().optional(),
  })
  .strict();

/** Plugin import: serialized nodes plus exported SVGs and image data (Story 8.3). */
export const IMPORT_MAX_BYTES = 12 * MB;
export const importRequest = z
  .object({
    fileKey: figmaFileKey.optional(),
    fileName: z.string().max(300).optional(),
    /** REST-shaped nodes (validated in depth by figma-convert's figmaNode schema). */
    nodes: z.array(z.unknown()).min(1).max(20),
    svgs: z
      .record(z.string().max(200), z.string().max(200_000))
      .refine((m) => Object.keys(m).length <= 300, 'Too many SVGs')
      .default({}),
    images: z
      .record(z.string().max(200), z.string().max(2 * MB))
      .refine((m) => Object.keys(m).length <= 50, 'Too many images')
      .default({}),
    /** Figma variable id -> name. */
    variables: z
      .record(z.string().max(200), z.string().max(300))
      .refine((m) => Object.keys(m).length <= 5000, 'Too many variables')
      .default({}),
  })
  .strict();

export const importUrlRequest = z.object({ url: z.string().max(2000) }).strict();

/** Token sync (Story 8.4): the plugin's variables snapshot plus the user's selections. */
export const SYNC_MAX_BYTES = 4 * MB;
export const syncRequest = z
  .object({
    fileKey: figmaFileKey,
    direction: z.enum(['pull', 'push']).default('pull'),
    snapshot: variablesSnapshot,
    selected: z.array(z.string().max(300)).max(10_000).default([]),
    resolutions: z
      .record(z.string().max(300), z.enum(['ours', 'theirs']))
      .refine((m) => Object.keys(m).length <= 10_000, 'Too many resolutions')
      .default({}),
  })
  .strict();
export const syncResultRequest = z
  .object({ fileKey: figmaFileKey, snapshot: variablesSnapshot })
  .strict();

export const PUSH_RESULT_MAX_BYTES = 2 * MB;
export const pushResultRequest = z
  .object({
    fileKey: figmaFileKey,
    fileName: z.string().max(300).optional(),
    pageId: figmaNodeId.optional(),
    docVersion: z.number().int().min(0),
    /** CrunchDesign NodeId (or component key) -> Figma node id. */
    nodeMap: z
      .record(z.string().max(200), figmaNodeId)
      .refine((m) => Object.keys(m).length <= 25_000, 'Too many nodes'),
    report,
  })
  .strict();
