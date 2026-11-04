/** Epic 5: conversations, messages, background jobs, job tokens, usage metering, model settings. */
import {
  bigint,
  boolean,
  bigserial,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { modelProviderEnumRef, projects, workspaces } from './core';

/** A chat thread with the agent. `scope` narrows inline requests: { nodeId, frameId } (Story 5.7). */
export const agentConversations = pgTable(
  'agent_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title'),
    scope: jsonb('scope'),
    /** Comment thread that started this conversation (agent_request threads). */
    commentThreadId: uuid('comment_thread_id'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('agent_conversations_project_idx').on(t.projectId, t.updatedAt)],
);

export const messageRoleEnum = pgEnum('agent_message_role', ['user', 'assistant', 'system']);
export const messageStatusEnum = pgEnum('agent_message_status', [
  'pending',
  'streaming',
  'complete',
  'error',
  'cancelled',
]);

/**
 * Messages are stored as Anthropic content blocks (append-only, so prompt caching and
 * thinking-block replay stay valid). Tool use/results live inside `content`.
 */
export const agentMessages = pgTable(
  'agent_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => agentConversations.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: messageRoleEnum('role').notNull(),
    content: jsonb('content').notNull(),
    status: messageStatusEnum('status').notNull().default('complete'),
    model: text('model'),
    /** Attachments: [{ type: 'asset', assetId } | { type: 'url', url } | { type: 'figma', fileKey, nodeId }] */
    attachments: jsonb('attachments').notNull().default([]),
    jobId: uuid('job_id'),
    /** Auto snapshot taken before this message's edits (Story 5.12). */
    snapshotVersionId: uuid('snapshot_version_id'),
    /** Doc transactions this message produced. */
    txnIds: text('txn_ids').array().notNull().default([]),
    error: text('error'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('agent_messages_conversation_seq_idx').on(t.conversationId, t.seq)],
);

export const jobKindEnum = pgEnum('job_kind', [
  'generate',
  'redesign',
  'alternatives',
  'web_capture',
  'ds_import_url',
  'ds_import_figma',
  'codegen',
  'figma_export',
]);

export const jobStatusEnum = pgEnum('job_status', [
  'queued',
  'provisioning',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

/** Long-running Agent SDK jobs in Vercel Sandbox (Story 5.1). */
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    designSystemId: uuid('design_system_id'),
    conversationId: uuid('conversation_id'),
    kind: jobKindEnum('kind').notNull(),
    /** Model override for jobs started without a chat message (null = workspace tier default). */
    model: text('model'),
    status: jobStatusEnum('status').notNull().default('queued'),
    input: jsonb('input').notNull(),
    result: jsonb('result'),
    error: text('error'),
    sandboxId: text('sandbox_id'),
    attempts: integer('attempts').notNull().default(0),
    timeoutSeconds: integer('timeout_seconds').notNull().default(1800),
    /** Next event seq to assign (events are 1-based). */
    lastEventSeq: integer('last_event_seq').notNull().default(0),
    createdBy: text('created_by').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('jobs_project_idx').on(t.projectId, t.createdAt),
    index('jobs_status_idx').on(t.status, t.heartbeatAt),
  ],
);

/** Progress stream for a job; clients resume with Last-Event-ID = seq. */
export const jobEvents = pgTable(
  'job_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(), // 'status' | 'progress' | 'log' | 'tool' | 'frame' | 'result' | 'error'
    data: jsonb('data').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('job_events_job_seq_idx').on(t.jobId, t.seq)],
);

/** Short-lived bearer tokens a sandbox uses for the LLM proxy and job API (Story 5.2). */
export const jobTokens = pgTable(
  'job_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('job_tokens_hash_idx').on(t.tokenHash)],
);

export const llmTaskEnum = pgEnum('llm_task', [
  'generation',
  'interactive',
  'utility',
  'codegen',
  'import',
  'lint',
  'test',
]);

/** One row per model call through the LLM proxy (Story 5.10). Cost in micro-dollars (estimated). */
export const llmCalls = pgTable(
  'llm_calls',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id'),
    projectId: uuid('project_id'),
    jobId: uuid('job_id'),
    conversationId: uuid('conversation_id'),
    messageId: uuid('message_id'),
    task: llmTaskEnum('task').notNull(),
    provider: modelProviderEnumRef('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    /** Portion of cacheWriteTokens written with the 1-hour TTL (billed at 2x vs 1.25x for 5m). */
    cacheWrite1hTokens: integer('cache_write_1h_tokens').notNull().default(0),
    latencyMs: integer('latency_ms'),
    estCostMicros: bigint('est_cost_micros', { mode: 'number' }).notNull().default(0),
    stopReason: text('stop_reason'),
    ok: boolean('ok').notNull().default(true),
    errorType: text('error_type'),
    requestId: text('request_id'),
    /** Free-form tags for analysis, e.g. { cacheTtl: '1h', stream: 'interactive' } (ADR 0002). */
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('llm_calls_workspace_idx').on(t.workspaceId, t.createdAt),
    index('llm_calls_user_idx').on(t.workspaceId, t.userId, t.createdAt),
    index('llm_calls_job_idx').on(t.jobId),
  ],
);

/** Per-workspace agent settings (Story 5.9): default model per tier, allowed models. */
export const workspaceAgentSettings = pgTable('workspace_agent_settings', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  modelDefaults: jsonb('model_defaults').notNull().default({}),
  allowedModels: text('allowed_models').array(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type AgentConversationRow = typeof agentConversations.$inferSelect;
export type AgentMessageRow = typeof agentMessages.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type JobEventRow = typeof jobEvents.$inferSelect;
export type LlmCallRow = typeof llmCalls.$inferSelect;
