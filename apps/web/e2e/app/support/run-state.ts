/**
 * Test data for one run of the app suite, created in the Clerk development instance through the
 * Backend API and deleted again by the teardown project. Everything a run creates carries its
 * run id (emails `e2e+<role>-<runId>+clerk_test@example.com`, org slugs `e2e-<runId>[-out]`), and
 * teardown deletes only ids recorded in the run file whose email or slug contains that run id.
 */
import fs from 'node:fs';
import { createClerkClient, type ClerkClient } from '@clerk/backend';
import { clerkKeys, STATE_DIR, STATE_FILE } from './env';

export const ROLES = ['admin', 'editor', 'editor2', 'viewer', 'outsider'] as const;
export type E2ERole = (typeof ROLES)[number];

/** Clerk organization role of each user in the run's workspace (the outsider owns another org). */
export const CLERK_ROLE: Record<Exclude<E2ERole, 'outsider'>, string> = {
  admin: 'org:admin',
  editor: 'org:editor',
  editor2: 'org:editor',
  viewer: 'org:viewer',
};

export interface E2EUser {
  role: E2ERole;
  id: string;
  email: string;
}
export interface E2EOrg {
  id: string;
  slug: string;
  name: string;
}
export interface RunState {
  runId: string;
  createdAt: string;
  users: Partial<Record<E2ERole, E2EUser>>;
  /** The workspace under test. */
  org?: E2EOrg;
  /** The outsider's own workspace. */
  outsiderOrg?: E2EOrg;
}

export const emailFor = (role: E2ERole, runId: string) =>
  `e2e+${role}-${runId}+clerk_test@example.com`;

export function newRunId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function clerkBackend(): ClerkClient {
  return createClerkClient({ secretKey: clerkKeys().secretKey });
}

export function writeRunState(state: RunState) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function readRunState(): RunState {
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as RunState;
}

/** The fully set-up run (for specs). */
export function requireRunState(): Required<RunState> & { users: Record<E2ERole, E2EUser> } {
  const s = readRunState();
  if (!s.org || !s.outsiderOrg || ROLES.some((r) => !s.users[r]))
    throw new Error('e2e run state is incomplete: did the setup project fail?');
  return s as Required<RunState> & { users: Record<E2ERole, E2EUser> };
}

/**
 * Create the run's users, workspace org and memberships, and the outsider's org. The state file
 * is rewritten after every step, so a failure part-way still leaves teardown a full record.
 */
export async function createRunData(runId: string): Promise<RunState> {
  const clerk = clerkBackend();
  const state: RunState = { runId, createdAt: new Date().toISOString(), users: {} };
  writeRunState(state);

  for (const role of ROLES) {
    const email = emailFor(role, runId);
    const u = await clerk.users.createUser({
      emailAddress: [email],
      firstName: 'E2E',
      lastName: role[0]!.toUpperCase() + role.slice(1),
      skipPasswordRequirement: true,
      skipPasswordChecks: true,
    });
    state.users[role] = { role, id: u.id, email };
    writeRunState(state);
  }

  const users = state.users as Record<E2ERole, E2EUser>;
  const org = await clerk.organizations.createOrganization({
    name: `E2E ${runId}`,
    slug: `e2e-${runId}`,
    createdBy: users.admin.id, // the creator becomes org:admin
  });
  state.org = { id: org.id, slug: org.slug!, name: org.name };
  writeRunState(state);
  for (const role of ['editor', 'editor2', 'viewer'] as const) {
    await clerk.organizations.createOrganizationMembership({
      organizationId: org.id,
      userId: users[role].id,
      role: CLERK_ROLE[role],
    });
  }

  const out = await clerk.organizations.createOrganization({
    name: `E2E ${runId} outsider`,
    slug: `e2e-${runId}-out`,
    createdBy: users.outsider.id,
  });
  state.outsiderOrg = { id: out.id, slug: out.slug!, name: out.name };
  writeRunState(state);
  return state;
}

const isNotFound = (e: unknown) =>
  typeof e === 'object' && e !== null && 'status' in e && (e as { status: number }).status === 404;

/**
 * Delete exactly what `state` recorded, after checking each id still belongs to this run (an
 * email or slug containing the run id). Returns what was deleted.
 */
export async function deleteRunData(state: RunState): Promise<{ users: number; orgs: number }> {
  const clerk = clerkBackend();
  const { runId } = state;
  if (!/^[a-z0-9]{8,}$/.test(runId)) throw new Error(`Refusing to clean up odd run id ${runId}`);
  let orgs = 0;
  let users = 0;
  for (const o of [state.org, state.outsiderOrg]) {
    if (!o) continue;
    try {
      const live = await clerk.organizations.getOrganization({ organizationId: o.id });
      if (!live.slug?.includes(runId)) throw new Error(`Org ${o.id} is not from run ${runId}`);
      await clerk.organizations.deleteOrganization(o.id);
      orgs++;
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }
  for (const u of Object.values(state.users)) {
    if (!u) continue;
    try {
      const live = await clerk.users.getUser(u.id);
      if (!live.emailAddresses.some((a) => a.emailAddress.includes(runId)))
        throw new Error(`User ${u.id} is not from run ${runId}`);
      await clerk.users.deleteUser(u.id);
      users++;
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }
  return { users, orgs };
}
