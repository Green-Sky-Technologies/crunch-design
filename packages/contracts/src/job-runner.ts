/**
 * Background job contract (Story 5.1).
 * Producer: stream-agent implements JobRunner on Vercel Sandbox (packages/sandbox-runner).
 * Consumers (Phase 2): design-system import (4.4, 4.5), codegen (7.3), Figma export.
 * Kinds and statuses mirror the `job_kind` / `job_status` DB enums.
 */
import { z } from 'zod';

export const JOB_KINDS = [
  'generate',
  'redesign',
  'alternatives',
  'web_capture',
  'ds_import_url',
  'ds_import_figma',
  'codegen',
  'figma_export',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = [
  'queued',
  'provisioning',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);

/** Per-kind input payloads (validated before a job is queued). */
export const jobInputs = {
  generate: z
    .object({
      prompt: z.string().min(1).max(20_000),
      frameCount: z.number().int().min(1).max(10).default(1),
    })
    .strict(),
  redesign: z
    .object({ prompt: z.string().min(1).max(20_000), frameIds: z.array(z.string()).min(1).max(20) })
    .strict(),
  alternatives: z
    .object({
      prompt: z.string().max(20_000),
      frameId: z.string(),
      count: z.number().int().min(2).max(5),
    })
    .strict(),
  web_capture: z.object({ url: z.url({ protocol: /^https?$/ }) }).strict(),
  ds_import_url: z
    .object({
      url: z.url({ protocol: /^https?$/ }).optional(),
      assetIds: z.array(z.uuid()).max(20).default([]),
    })
    .strict(),
  ds_import_figma: z.object({ fileKey: z.string().max(64) }).strict(),
  codegen: z
    .object({ target: z.literal('react-tailwind'), frameIds: z.array(z.string()).optional() })
    .strict(),
  figma_export: z.object({ fileKey: z.string().max(64).optional() }).strict(),
} satisfies Record<JobKind, z.ZodType>;
export type JobInput<K extends JobKind> = z.infer<(typeof jobInputs)[K]>;

/** Event types on a job's resumable stream (job_events.type). */
export type JobEventType = 'status' | 'progress' | 'log' | 'tool' | 'frame' | 'result' | 'error';

export interface JobEvent {
  seq: number;
  type: JobEventType;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface StartJob {
  jobId: string;
  workspaceId: string;
  kind: JobKind;
  input: unknown;
  timeoutSeconds: number;
}

/** Runs jobs somewhere (Vercel Sandbox now; maybe Fargate later). Persistence of jobs/events is separate. */
export interface JobRunner {
  start(job: StartJob): Promise<{ sandboxId: string }>;
  cancel(jobId: string, sandboxId: string): Promise<void>;
  /** Best-effort liveness check for reaping orphaned sandboxes. */
  isAlive(sandboxId: string): Promise<boolean>;
}

/** Client-side SSE endpoint for job events; resume with the Last-Event-ID header (= seq). */
export const jobEventsUrl = (jobId: string) => `/api/jobs/${jobId}/events`;
