import { createDb, sql, type Db } from '@crunch/db';
import type { Role } from '@crunch/authz';
import { upsertWorkspace } from '@/server/services/workspaces';
import type { Actor } from '@/server/services/types';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://crunch:crunch@localhost:5433/crunch_test';

export function testDb(): { db: Db; close: () => Promise<void> } {
  return createDb(url);
}

export async function reset(db: Db) {
  await db.execute(sql`truncate table workspaces, users restart identity cascade`);
}

let n = 0;
export async function makeActor(
  db: Db,
  role: Role,
  workspace?: Actor['workspace'],
): Promise<Actor> {
  n++;
  const ws =
    workspace ??
    (await upsertWorkspace(db, { clerkOrgId: `org_${n}`, name: `WS ${n}`, slug: `ws-${n}` }));
  return { userId: `user_${n}`, role, workspace: ws };
}
