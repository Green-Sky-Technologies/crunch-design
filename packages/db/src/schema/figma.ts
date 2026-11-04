/** Epic 8: Figma plugin tokens, REST credentials, push/import links, variable sync links. */
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { designSystems, projects, workspaces } from './core';

/** Tokens the CrunchDesign Figma plugin uses to call our API (Story 8.1). Only the hash is stored. */
export const pluginTokens = pgTable(
  'plugin_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    last4: text('last4').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('plugin_tokens_hash_idx').on(t.tokenHash),
    index('plugin_tokens_workspace_idx').on(t.workspaceId),
  ],
);

/** A user's Figma REST token for imports (Story 8.3), envelope-encrypted like provider keys. */
export const figmaCredentials = pgTable(
  'figma_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    tokenEnvelope: text('token_envelope').notNull(),
    hint: text('hint').notNull(),
    figmaUserHandle: text('figma_user_handle'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('figma_credentials_user_idx').on(t.workspaceId, t.userId)],
);

export const figmaDirectionEnum = pgEnum('figma_direction', ['push', 'import']);

/** Link between a project and a Figma file, with the last mapping/fidelity report. */
export const figmaLinks = pgTable(
  'figma_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    direction: figmaDirectionEnum('direction').notNull(),
    figmaFileKey: text('figma_file_key').notNull(),
    figmaFileName: text('figma_file_name'),
    figmaPageId: text('figma_page_id'),
    /** CrunchDesign NodeId -> Figma node id (also mirrored in Figma plugin data). */
    nodeMap: jsonb('node_map').notNull().default({}),
    lastReport: jsonb('last_report'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex('figma_links_project_file_idx').on(t.projectId, t.figmaFileKey, t.direction)],
);

/** Design system <-> Figma variable collections (Story 8.4). */
export const figmaVariableLinks = pgTable(
  'figma_variable_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    designSystemId: uuid('design_system_id')
      .notNull()
      .references(() => designSystems.id, { onDelete: 'cascade' }),
    figmaFileKey: text('figma_file_key').notNull(),
    /** Token path <-> Figma variable id, and mode mapping (light/dark -> theme variants). */
    mapping: jsonb('mapping').notNull().default({}),
    lastPulledAt: timestamp('last_pulled_at', { withTimezone: true }),
    lastPushedAt: timestamp('last_pushed_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('figma_variable_links_ds_file_idx').on(t.designSystemId, t.figmaFileKey)],
);

export type PluginTokenRow = typeof pluginTokens.$inferSelect;
export type FigmaLinkRow = typeof figmaLinks.$inferSelect;
