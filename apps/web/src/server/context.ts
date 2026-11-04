import 'server-only';
import { auth, clerkClient } from '@clerk/nextjs/server';
import { roleFromClerk } from '@crunch/authz';
import { getDb } from '@crunch/db';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import type { Actor } from './services/types';
import { findWorkspaceByOrg, upsertMember, upsertWorkspace } from './services/workspaces';

export const db = () => getDb();

/**
 * Resolve the signed-in user, their active workspace (Clerk org) and role.
 * Lazily mirrors the org and membership into Postgres, so webhooks are an optimization,
 * not a requirement. Memoized per request.
 */
export const getActor = cache(async (): Promise<Actor | null> => {
  const { userId, orgId, orgRole, orgSlug } = await auth();
  if (!userId || !orgId) return null;

  let workspace = await findWorkspaceByOrg(db(), orgId);
  if (!workspace || (orgSlug && workspace.slug !== orgSlug)) {
    const org = await (
      await clerkClient()
    ).organizations.getOrganization({ organizationId: orgId });
    workspace = await upsertWorkspace(db(), {
      clerkOrgId: org.id,
      name: org.name,
      slug: org.slug ?? org.id,
      imageUrl: org.imageUrl,
    });
  }
  const role = roleFromClerk(orgRole);
  await upsertMember(db(), workspace.id, userId, role);
  return { userId, role, workspace };
});

/** For pages: redirect to sign-in or org selection when there's no actor. */
export async function requireActor(slug?: string): Promise<Actor> {
  const { userId } = await auth();
  if (!userId) redirect('/sign-in');
  const actor = await getActor();
  if (!actor) redirect('/session-tasks/choose-organization');
  // clerkMiddleware's organizationSyncOptions activates the org named in the URL. If the
  // user isn't a member of it, the slugs still differ here: send them to their own workspace.
  if (slug && actor.workspace.slug !== slug) redirect(`/w/${actor.workspace.slug}`);
  return actor;
}
