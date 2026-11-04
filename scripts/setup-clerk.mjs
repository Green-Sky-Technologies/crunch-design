#!/usr/bin/env node
/**
 * Configure a Clerk instance for CrunchDesign with only its secret key (Backend API):
 *  - Organizations on (workspaces), with slugs (workspace URLs are /w/<slug>) and forced selection
 *  - the org:editor and org:viewer roles next to org:admin (see packages/authz)
 *  - org:viewer as the default role for new members
 *
 * Safe to re-run. Runs automatically in the Vercel build (scripts/vercel-build.mjs); run it by
 * hand with `pnpm setup:clerk` (reads CLERK_SECRET_KEY from the env or apps/web/.env.local).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API = 'https://api.clerk.com/v1';

function secretKey() {
  if (process.env.CLERK_SECRET_KEY) return process.env.CLERK_SECRET_KEY;
  try {
    const env = readFileSync(new URL('../apps/web/.env.local', import.meta.url), 'utf8');
    const m = env.match(/^CLERK_SECRET_KEY=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    // no .env.local
  }
  return undefined;
}

async function clerk(key, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = json?.errors?.[0]?.long_message ?? json?.errors?.[0]?.message ?? res.statusText;
    throw new Error(`${method} ${path}: ${res.status} ${msg}`);
  }
  return json;
}

const ROLES = [
  {
    key: 'org:editor',
    name: 'Editor',
    description: 'Design, comment, run the agent and LLM exports',
  },
  {
    key: 'org:viewer',
    name: 'Viewer',
    description: 'View-only: view designs and run deterministic exports',
  },
];

export async function setupClerk({ key = secretKey(), log = console.log } = {}) {
  if (!key) throw new Error('CLERK_SECRET_KEY is not set');

  log('• Organizations: on, with slugs and forced selection');
  await clerk(key, 'PATCH', '/instance/organization_settings', {
    enabled: true,
    slug_disabled: false,
    force_organization_selection: true,
  });

  const list = (r) => (Array.isArray(r) ? r : (r?.data ?? []));
  const perms = list(await clerk(key, 'GET', '/organization_permissions?limit=100'));
  const readMembers = perms.find((p) => p.key === 'org:sys_memberships:read');
  const existing = new Set(
    list(await clerk(key, 'GET', '/organization_roles?limit=100')).map((r) => r.key),
  );
  for (const role of ROLES) {
    if (existing.has(role.key)) {
      log(`• Role ${role.key} exists`);
      continue;
    }
    log(`• Creating role ${role.key}`);
    const created = await clerk(key, 'POST', '/organization_roles', role);
    // Members can see who else is in their workspace.
    if (readMembers)
      await clerk(key, 'POST', `/organization_roles/${created.id}/permissions/${readMembers.id}`);
  }

  log('• Default role for new members: org:viewer');
  await clerk(key, 'PATCH', '/role_sets/role_set:default', { default_role_key: 'org:viewer' });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  setupClerk().then(
    () => console.log('Clerk is configured.'),
    (e) => {
      console.error(`Clerk setup failed: ${e.message}`);
      process.exit(1);
    },
  );
}
