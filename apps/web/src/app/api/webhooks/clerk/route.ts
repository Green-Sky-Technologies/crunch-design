/**
 * Clerk → Postgres sync. Configure in the Clerk Dashboard → Webhooks with the events below,
 * and set CLERK_WEBHOOK_SIGNING_SECRET. Requests are verified with Svix signatures.
 */
import { roleFromClerk } from '@crunch/authz';
import { getDb } from '@crunch/db';
import { verifyWebhook } from '@clerk/nextjs/webhooks';
import type { NextRequest } from 'next/server';
import {
  deleteUser,
  findWorkspaceByOrg,
  markWorkspaceDeleted,
  removeMember,
  upsertMember,
  upsertUser,
  upsertWorkspace,
} from '@/server/services/workspaces';

export async function POST(req: NextRequest) {
  let evt;
  try {
    evt = await verifyWebhook(req);
  } catch {
    return new Response('Invalid signature', { status: 400 });
  }
  const db = getDb();

  switch (evt.type) {
    case 'user.created':
    case 'user.updated': {
      const u = evt.data;
      const primary = u.email_addresses.find((e) => e.id === u.primary_email_address_id);
      await upsertUser(db, {
        id: u.id,
        email: primary?.email_address ?? null,
        name: [u.first_name, u.last_name].filter(Boolean).join(' ') || null,
        imageUrl: u.image_url,
      });
      break;
    }
    case 'user.deleted':
      if (evt.data.id) await deleteUser(db, evt.data.id);
      break;
    case 'organization.created':
    case 'organization.updated': {
      const o = evt.data;
      await upsertWorkspace(db, {
        clerkOrgId: o.id,
        name: o.name,
        slug: o.slug,
        imageUrl: o.image_url ?? null,
      });
      break;
    }
    case 'organization.deleted':
      if (evt.data.id) await markWorkspaceDeleted(db, evt.data.id);
      break;
    case 'organizationMembership.created':
    case 'organizationMembership.updated': {
      const m = evt.data;
      const ws =
        (await findWorkspaceByOrg(db, m.organization.id)) ??
        (await upsertWorkspace(db, {
          clerkOrgId: m.organization.id,
          name: m.organization.name,
          slug: m.organization.slug,
          imageUrl: m.organization.image_url ?? null,
        }));
      await upsertMember(db, ws.id, m.public_user_data.user_id, roleFromClerk(m.role));
      break;
    }
    case 'organizationMembership.deleted': {
      const m = evt.data;
      const ws = await findWorkspaceByOrg(db, m.organization.id);
      if (ws) await removeMember(db, ws.id, m.public_user_data.user_id);
      break;
    }
  }
  return new Response('ok');
}
