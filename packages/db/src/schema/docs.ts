/**
 * Epic 2 (+ 5.12, 6.2): DesignDocs, the append-only op log, version snapshots, assets.
 * The DesignDoc JSON shape is defined and validated by @crunch/doc-model.
 */
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
import { actorTypeEnum, opSourceEnum } from './enums';

/** Current materialized document per project (one doc per project). */
export const designDocs = pgTable('design_docs', {
  projectId: uuid('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** Monotonic; incremented once per committed transaction. */
  version: integer('version').notNull().default(0),
  doc: jsonb('doc').notNull(),
  /** Bumped when `doc` was last rewritten from the op log (compaction). */
  compactedVersion: integer('compacted_version').notNull().default(0),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** One row per committed transaction (a batch of ops = one undo step). */
export const docOps = pgTable(
  'doc_ops',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Doc version after applying this transaction. */
    version: integer('version').notNull(),
    txnId: text('txn_id').notNull(),
    ops: jsonb('ops').notNull(),
    inverse: jsonb('inverse').notNull(),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    source: opSourceEnum('source').notNull(),
    /** Agent message that produced this txn (Epic 5). */
    agentMessageId: uuid('agent_message_id'),
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('doc_ops_project_version_idx').on(t.projectId, t.version),
    uniqueIndex('doc_ops_project_txn_idx').on(t.projectId, t.txnId),
  ],
);

export const docVersionKindEnum = pgEnum('doc_version_kind', ['auto', 'named']);

/** Full-document snapshots: auto (before agent edits, Story 5.12) and named (Story 6.2). */
export const docVersions = pgTable(
  'doc_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: docVersionKindEnum('kind').notNull(),
    name: text('name'),
    description: text('description'),
    /** design_docs.version at the time of the snapshot. */
    docVersion: integer('doc_version').notNull(),
    doc: jsonb('doc').notNull(),
    thumbnailUrl: text('thumbnail_url'),
    /** For auto snapshots: the agent message about to edit. */
    agentMessageId: uuid('agent_message_id'),
    /** If this snapshot was created by restoring another version. */
    restoredFromId: uuid('restored_from_id'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('doc_versions_project_idx').on(t.projectId, t.kind, t.createdAt)],
);

export const assetKindEnum = pgEnum('asset_kind', [
  'upload',
  'screenshot',
  'thumbnail',
  'capture',
  'export',
  'figma',
]);

/** Files in Vercel Blob (uploads, screenshots, thumbnails, web captures, export ZIPs). */
export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    kind: assetKindEnum('kind').notNull(),
    blobUrl: text('blob_url').notNull(),
    pathname: text('pathname').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    width: integer('width'),
    height: integer('height'),
    sha256: text('sha256'),
    meta: jsonb('meta'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('assets_project_idx').on(t.projectId, t.kind)],
);

export type DesignDocRow = typeof designDocs.$inferSelect;
export type DocOpRow = typeof docOps.$inferSelect;
export type DocVersionRow = typeof docVersions.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
