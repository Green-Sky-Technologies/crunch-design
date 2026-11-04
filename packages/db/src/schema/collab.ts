/** Epics 3.8 and 6: edit locks, comments, notifications, share links, activity. */
import {
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
import { projects, workspaces } from './core';
import { actorTypeEnum } from './enums';

/** Soft edit lock per project (Story 3.8). Expired when heartbeat_at + ttl < now. */
export const editLocks = pgTable('edit_locks', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  holderUserId: text('holder_user_id').notNull(),
  /** Identifies the tab/session holding the lock (one user, two tabs). */
  sessionId: text('session_id').notNull(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
  requestedBy: text('requested_by'),
  requestedAt: timestamp('requested_at', { withTimezone: true }),
});

/** Who is currently viewing a project (presence avatars). Rows expire by last_seen_at. */
export const presence = pgTable(
  'presence',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    sessionId: text('session_id').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('presence_project_session_idx').on(t.projectId, t.sessionId)],
);

export const threadStatusEnum = pgEnum('comment_thread_status', ['open', 'resolved']);
export const threadKindEnum = pgEnum('comment_thread_kind', ['discussion', 'agent_request']);

/**
 * A pinned comment thread. `anchor` is
 *   { type: 'node', frameId, nodeId, offset?: {x,y} } | { type: 'canvas', x, y }
 * When the node is deleted, the thread keeps its last known canvas position (`fallback`).
 */
export const commentThreads = pgTable(
  'comment_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: threadKindEnum('kind').notNull().default('discussion'),
    status: threadStatusEnum('status').notNull().default('open'),
    anchor: jsonb('anchor').notNull(),
    fallback: jsonb('fallback'),
    /** For agent_request threads: the agent conversation handling it (Story 5.7). */
    agentConversationId: uuid('agent_conversation_id'),
    resolvedBy: text('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index('comment_threads_project_idx').on(t.projectId, t.status)],
);

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => commentThreads.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    authorType: actorTypeEnum('author_type').notNull().default('user'),
    authorId: text('author_id').notNull(),
    body: text('body').notNull(),
    /** Clerk user ids mentioned with @. */
    mentions: text('mentions').array().notNull().default([]),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('comments_thread_idx').on(t.threadId, t.createdAt)],
);

/** In-app notifications (mentions, control requests, job completions). */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    kind: text('kind').notNull(), // 'mention' | 'control_request' | 'job_finished' | ...
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    data: jsonb('data').notNull().default({}),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.readAt, t.createdAt)],
);

export const shareVisibilityEnum = pgEnum('share_visibility', ['workspace', 'public']);

/** Share links (Story 6.3). Only a hash of the token is stored. */
export const shareLinks = pgTable(
  'share_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    visibility: shareVisibilityEnum('visibility').notNull().default('workspace'),
    /** Optional subset of frames; null = all frames. */
    frameIds: text('frame_ids').array(),
    /** Pin to a named version; null = live document. */
    docVersionId: uuid('doc_version_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    viewCount: integer('view_count').notNull().default(0),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('share_links_token_idx').on(t.tokenHash),
    index('share_links_project_idx').on(t.projectId),
  ],
);

/** Activity feed (Story 6.4). `verb` e.g. 'doc.edited', 'version.named', 'comment.created'. */
export const activity = pgTable(
  'activity',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    verb: text('verb').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    data: jsonb('data').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('activity_project_idx').on(t.projectId, t.createdAt),
    index('activity_workspace_idx').on(t.workspaceId, t.createdAt),
  ],
);

export type EditLockRow = typeof editLocks.$inferSelect;
export type CommentThreadRow = typeof commentThreads.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;
export type ShareLinkRow = typeof shareLinks.$inferSelect;
export type ActivityRow = typeof activity.$inferSelect;
