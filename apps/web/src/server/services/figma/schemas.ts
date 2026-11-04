/** Zod schemas and size limits for inbound plugin payloads (Epic 8). */
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
