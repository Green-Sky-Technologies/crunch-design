/**
 * Epic 1 schema: users, workspaces, members, credentials, projects, design systems.
 * Later epics add tables in their own files (see SPEC §5) and re-export them here.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const roleEnum = pgEnum('member_role', ['admin', 'editor', 'viewer']);
export const providerEnum = pgEnum('model_provider', ['anthropic', 'bedrock', 'vertex', 'foundry']);
export const credentialStatusEnum = pgEnum('credential_status', ['untested', 'ok', 'error']);

/** Mirror of Clerk users (synced by webhook and lazily on request). */
export const users = pgTable('users', {
  id: text('id').primaryKey(), // Clerk user id
  email: text('email'),
  name: text('name'),
  imageUrl: text('image_url'),
  ...timestamps,
});

/** A workspace mirrors a Clerk Organization. */
export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clerkOrgId: text('clerk_org_id').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    imageUrl: text('image_url'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('workspaces_clerk_org_id_idx').on(t.clerkOrgId)],
);

export const members = pgTable(
  'members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(), // Clerk user id
    role: roleEnum('role').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('members_workspace_user_idx').on(t.workspaceId, t.userId),
    index('members_user_idx').on(t.userId),
  ],
);

/**
 * One model credential per workspace (SPEC D8). `secretEnvelope` is an @crunch/crypto
 * envelope bound to the workspace id. It never leaves the server.
 */
export const providerCredentials = pgTable(
  'provider_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: providerEnum('provider').notNull(),
    config: jsonb('config').notNull(),
    secretEnvelope: text('secret_envelope'),
    hint: text('hint').notNull(),
    status: credentialStatusEnum('status').notNull().default('untested'),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('provider_credentials_workspace_idx').on(t.workspaceId)],
);

/**
 * Stable per-workspace external id for Bedrock role assumption. It's kept separate from the
 * credential so it survives credential replacement (the customer's trust policy references it).
 */
export const workspaceAwsExternalIds = pgTable('workspace_aws_external_ids', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  externalId: text('external_id').notNull(),
  ...timestamps,
});

/** Minimal design system row. Epic 4 adds versions, tokens, and components. */
export const designSystems = pgTable(
  'design_systems',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index('design_systems_workspace_idx').on(t.workspaceId),
    uniqueIndex('design_systems_one_default_idx')
      .on(t.workspaceId)
      .where(sql`${t.isDefault} = true`),
  ],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    designSystemId: uuid('design_system_id')
      .notNull()
      .references(() => designSystems.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description'),
    thumbnailUrl: text('thumbnail_url'),
    createdBy: text('created_by').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('projects_workspace_idx').on(t.workspaceId, t.archivedAt, t.updatedAt)],
);

export type Workspace = typeof workspaces.$inferSelect;
export type Member = typeof members.$inferSelect;
export type ProviderCredentialRow = typeof providerCredentials.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type DesignSystem = typeof designSystems.$inferSelect;
