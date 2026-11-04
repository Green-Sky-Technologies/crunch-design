import { assertCan } from '@crunch/authz';
import {
  and,
  designSystems,
  desc,
  eq,
  isNotNull,
  isNull,
  projects,
  type Db,
  type Project,
} from '@crunch/db';
import { z } from 'zod';
import { NotFoundError, ValidationError, type Actor } from './types';

const nameSchema = z.string().trim().min(1, 'Name is required').max(120, 'Name is too long');
const descriptionSchema = z.string().trim().max(1000).optional();

function parse<T>(schema: z.ZodType<T>, value: unknown, field: string): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const msg = r.error.issues[0]?.message ?? 'Invalid value';
    throw new ValidationError(msg, { [field]: [msg] });
  }
  return r.data;
}

export async function listProjects(
  db: Db,
  actor: Actor,
  opts: { archived?: boolean } = {},
): Promise<Project[]> {
  assertCan(actor.role, 'project:read');
  return db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.workspaceId, actor.workspace.id),
        opts.archived ? isNotNull(projects.archivedAt) : isNull(projects.archivedAt),
      ),
    )
    .orderBy(desc(projects.updatedAt));
}

/** Scoped to the actor's workspace, so a project id from another workspace is "not found" (no IDOR). */
export async function getProject(db: Db, actor: Actor, projectId: string): Promise<Project> {
  assertCan(actor.role, 'project:read');
  if (!z.uuid().safeParse(projectId).success) throw new NotFoundError('Project not found');
  const [p] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, actor.workspace.id)))
    .limit(1);
  if (!p) throw new NotFoundError('Project not found');
  return p;
}

async function defaultDesignSystemId(db: Db, workspaceId: string): Promise<string> {
  const [ds] = await db
    .select({ id: designSystems.id })
    .from(designSystems)
    .where(and(eq(designSystems.workspaceId, workspaceId), eq(designSystems.isDefault, true)))
    .limit(1);
  if (ds) return ds.id;
  const [created] = await db
    .insert(designSystems)
    .values({ workspaceId, name: 'Default', isDefault: true })
    .onConflictDoNothing()
    .returning({ id: designSystems.id });
  if (created) return created.id;
  return defaultDesignSystemId(db, workspaceId);
}

export async function createProject(
  db: Db,
  actor: Actor,
  input: { name: unknown; description?: unknown },
): Promise<Project> {
  assertCan(actor.role, 'project:create');
  const name = parse(nameSchema, input.name, 'name');
  const description = parse(descriptionSchema, input.description || undefined, 'description');
  const designSystemId = await defaultDesignSystemId(db, actor.workspace.id);
  const [p] = await db
    .insert(projects)
    .values({
      workspaceId: actor.workspace.id,
      designSystemId,
      name,
      description: description ?? null,
      createdBy: actor.userId,
    })
    .returning();
  return p!;
}

export async function renameProject(
  db: Db,
  actor: Actor,
  projectId: string,
  name: unknown,
): Promise<Project> {
  assertCan(actor.role, 'project:update');
  const next = parse(nameSchema, name, 'name');
  await getProject(db, actor, projectId);
  const [p] = await db
    .update(projects)
    .set({ name: next })
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, actor.workspace.id)))
    .returning();
  return p!;
}

/** Duplicates project metadata. Epic 2 extends this to copy the DesignDoc. */
export async function duplicateProject(db: Db, actor: Actor, projectId: string): Promise<Project> {
  assertCan(actor.role, 'project:create');
  const src = await getProject(db, actor, projectId);
  const [p] = await db
    .insert(projects)
    .values({
      workspaceId: src.workspaceId,
      designSystemId: src.designSystemId,
      name: `${src.name} (copy)`.slice(0, 120),
      description: src.description,
      thumbnailUrl: src.thumbnailUrl,
      createdBy: actor.userId,
    })
    .returning();
  return p!;
}

export async function setProjectArchived(
  db: Db,
  actor: Actor,
  projectId: string,
  archived: boolean,
): Promise<Project> {
  assertCan(actor.role, 'project:archive');
  await getProject(db, actor, projectId);
  const [p] = await db
    .update(projects)
    .set({ archivedAt: archived ? new Date() : null })
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, actor.workspace.id)))
    .returning();
  return p!;
}
