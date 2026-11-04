/**
 * Mirror Clerk organizations, users and memberships into Postgres.
 * Called from the Clerk webhook and lazily on each request, so local dev works
 * without a webhook tunnel.
 */
import type { Role } from '@crunch/authz';
import {
  and,
  designSystems,
  eq,
  members,
  users,
  workspaces,
  type Db,
  type Workspace,
} from '@crunch/db';

export interface OrgInfo {
  clerkOrgId: string;
  name: string;
  slug: string;
  imageUrl?: string | null;
}

/** Create or update the workspace and make sure it has a default design system. */
export async function upsertWorkspace(db: Db, org: OrgInfo): Promise<Workspace> {
  return db.transaction(async (tx) => {
    const [ws] = await tx
      .insert(workspaces)
      .values({
        clerkOrgId: org.clerkOrgId,
        name: org.name,
        slug: org.slug,
        imageUrl: org.imageUrl ?? null,
      })
      .onConflictDoUpdate({
        target: workspaces.clerkOrgId,
        set: { name: org.name, slug: org.slug, imageUrl: org.imageUrl ?? null, deletedAt: null },
      })
      .returning();
    await tx
      .insert(designSystems)
      .values({ workspaceId: ws!.id, name: 'Default', isDefault: true })
      .onConflictDoNothing();
    return ws!;
  });
}

export async function findWorkspaceByOrg(
  db: Db,
  clerkOrgId: string,
): Promise<Workspace | undefined> {
  const [ws] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.clerkOrgId, clerkOrgId))
    .limit(1);
  return ws && !ws.deletedAt ? ws : undefined;
}

export async function markWorkspaceDeleted(db: Db, clerkOrgId: string): Promise<void> {
  await db
    .update(workspaces)
    .set({ deletedAt: new Date() })
    .where(eq(workspaces.clerkOrgId, clerkOrgId));
}

export async function upsertUser(
  db: Db,
  user: { id: string; email?: string | null; name?: string | null; imageUrl?: string | null },
): Promise<void> {
  const values = {
    email: user.email ?? null,
    name: user.name ?? null,
    imageUrl: user.imageUrl ?? null,
  };
  await db
    .insert(users)
    .values({ id: user.id, ...values })
    .onConflictDoUpdate({ target: users.id, set: values });
}

export async function deleteUser(db: Db, userId: string): Promise<void> {
  await db.delete(members).where(eq(members.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

export async function upsertMember(
  db: Db,
  workspaceId: string,
  userId: string,
  role: Role,
): Promise<void> {
  await db
    .insert(members)
    .values({ workspaceId, userId, role })
    .onConflictDoUpdate({ target: [members.workspaceId, members.userId], set: { role } });
}

export async function removeMember(db: Db, workspaceId: string, userId: string): Promise<void> {
  await db
    .delete(members)
    .where(and(eq(members.workspaceId, workspaceId), eq(members.userId, userId)));
}
