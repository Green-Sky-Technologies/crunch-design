/**
 * Named versions (Story 6.2) on top of the snapshot primitive (services/snapshots.ts).
 * Restoring applies a normal transaction after an automatic backup snapshot, so it creates a
 * new doc version, is itself undoable/restorable, and never deletes history.
 */
import { assertCan } from '@crunch/authz';
import { inArray, users, type Db } from '@crunch/db';
import type { DesignDoc } from '@crunch/doc-model';
import { z } from 'zod';
import { recordActivity } from './activity';
import type { CommitResult } from './design-docs';
import {
  createSnapshot,
  getSnapshotDoc,
  listSnapshots,
  restoreSnapshot,
  type SnapshotSummary,
} from './snapshots';
import { NotFoundError, ValidationError, type Actor } from './types';

export type VersionSummary = SnapshotSummary & { createdByName: string | null };

const createInput = z
  .object({
    name: z.string().trim().min(1, 'Name the version').max(120),
    description: z.string().trim().max(2000).optional(),
  })
  .strict();

async function withNames(db: Db, rows: SnapshotSummary[]): Promise<VersionSummary[]> {
  const ids = [...new Set(rows.map((r) => r.createdBy))];
  const names = ids.length
    ? await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(inArray(users.id, ids))
    : [];
  const byId = new Map(names.map((n) => [n.id, n.name ?? n.email ?? null]));
  return rows.map((r) => ({ ...r, createdByName: byId.get(r.createdBy) ?? null }));
}

export async function listVersions(
  db: Db,
  actor: Actor,
  projectId: string,
  opts: { includeAuto?: boolean; limit?: number } = {},
): Promise<VersionSummary[]> {
  const rows = await listSnapshots(db, actor, projectId, {
    kind: opts.includeAuto ? undefined : 'named',
    limit: opts.limit,
  });
  return withNames(db, rows);
}

export async function createNamedVersion(
  db: Db,
  actor: Actor,
  projectId: string,
  input: unknown,
): Promise<VersionSummary> {
  assertCan(actor.role, 'design:edit');
  const r = createInput.safeParse(input);
  if (!r.success)
    throw new ValidationError(r.error.issues[0]?.message ?? 'Invalid version', {
      name: r.error.issues.filter((i) => i.path[0] === 'name').map((i) => i.message),
    });
  const summary = await createSnapshot(db, actor, projectId, {
    kind: 'named',
    name: r.data.name,
    description: r.data.description || undefined,
  });
  await recordActivity(db, actor, {
    projectId,
    verb: 'version.named',
    targetType: 'doc_version',
    targetId: summary.id,
    data: { name: summary.name, docVersion: summary.docVersion },
  });
  return (await withNames(db, [summary]))[0]!;
}

export async function getVersion(
  db: Db,
  actor: Actor,
  projectId: string,
  versionId: string,
): Promise<{ version: VersionSummary; doc: DesignDoc }> {
  const { summary, doc } = await getSnapshotDoc(db, actor, projectId, versionId);
  return { version: (await withNames(db, [summary]))[0]!, doc };
}

export async function restoreVersion(
  db: Db,
  actor: Actor,
  projectId: string,
  versionId: string,
): Promise<CommitResult & { backupId: string }> {
  assertCan(actor.role, 'design:edit');
  const { summary } = await getSnapshotDoc(db, actor, projectId, versionId);
  const result = await restoreSnapshot(db, actor, projectId, versionId);
  await recordActivity(db, actor, {
    projectId,
    verb: 'version.restored',
    targetType: 'doc_version',
    targetId: versionId,
    data: {
      name: summary.name,
      kind: summary.kind,
      backupId: result.backupId,
      docVersion: result.version,
    },
  });
  return result;
}

/** For callers that only have a version id (e.g. share links pinned to a version). */
export async function versionBelongsToProject(
  db: Db,
  actor: Actor,
  projectId: string,
  versionId: string,
): Promise<boolean> {
  try {
    await getSnapshotDoc(db, actor, projectId, versionId);
    return true;
  } catch (e) {
    if (e instanceof NotFoundError) return false;
    throw e;
  }
}
