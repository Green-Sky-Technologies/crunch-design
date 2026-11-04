/**
 * Full-document snapshots: the primitive behind auto snapshots before agent edits (Story 5.12)
 * and named versions (Story 6.2). Restoring applies a normal transaction (source 'restore'),
 * so it's undoable, and takes an auto snapshot first. History is never destroyed.
 */
import { assertCan } from '@crunch/authz';
import { and, desc, docVersions, eq, type Db, type DocVersionRow } from '@crunch/db';
import { newId, replaceDocOps, type DesignDoc } from '@crunch/doc-model';
import { z } from 'zod';
import { commitTransaction, getDoc, type CommitResult } from './design-docs';
import { getProject } from './projects';
import { NotFoundError, ValidationError, type Actor } from './types';

export type SnapshotSummary = Omit<DocVersionRow, 'doc'>;

const nameSchema = z.string().trim().min(1).max(120);

export async function createSnapshot(
  db: Db,
  actor: Actor,
  projectId: string,
  input: { kind: 'auto' | 'named'; name?: string; description?: string; agentMessageId?: string },
): Promise<SnapshotSummary> {
  // Auto snapshots happen as part of edits; named versions are an explicit editor action.
  assertCan(actor.role, 'design:edit');
  let name: string | null = null;
  if (input.kind === 'named') {
    const r = nameSchema.safeParse(input.name);
    if (!r.success) throw new ValidationError('Version name is required', { name: ['Required'] });
    name = r.data;
  }
  const { doc, version } = await getDoc(db, actor, projectId);
  const [row] = await db
    .insert(docVersions)
    .values({
      projectId,
      workspaceId: actor.workspace.id,
      kind: input.kind,
      name,
      description: input.description?.slice(0, 2000) ?? null,
      docVersion: version,
      doc,
      agentMessageId: input.agentMessageId ?? null,
      createdBy: actor.userId,
    })
    .returning();
  const { doc: _omit, ...summary } = row!;
  void _omit;
  return summary;
}

export async function listSnapshots(
  db: Db,
  actor: Actor,
  projectId: string,
  opts: { kind?: 'auto' | 'named'; limit?: number } = {},
): Promise<SnapshotSummary[]> {
  assertCan(actor.role, 'project:read');
  await getProject(db, actor, projectId);
  const rows = await db
    .select({
      id: docVersions.id,
      projectId: docVersions.projectId,
      workspaceId: docVersions.workspaceId,
      kind: docVersions.kind,
      name: docVersions.name,
      description: docVersions.description,
      docVersion: docVersions.docVersion,
      thumbnailUrl: docVersions.thumbnailUrl,
      agentMessageId: docVersions.agentMessageId,
      restoredFromId: docVersions.restoredFromId,
      createdBy: docVersions.createdBy,
      createdAt: docVersions.createdAt,
    })
    .from(docVersions)
    .where(
      and(
        eq(docVersions.projectId, projectId),
        opts.kind ? eq(docVersions.kind, opts.kind) : undefined,
      ),
    )
    .orderBy(desc(docVersions.createdAt))
    .limit(Math.min(opts.limit ?? 100, 500));
  return rows;
}

export async function getSnapshotDoc(
  db: Db,
  actor: Actor,
  projectId: string,
  snapshotId: string,
): Promise<{ summary: SnapshotSummary; doc: DesignDoc }> {
  assertCan(actor.role, 'project:read');
  await getProject(db, actor, projectId);
  if (!z.uuid().safeParse(snapshotId).success) throw new NotFoundError('Version not found');
  const [row] = await db
    .select()
    .from(docVersions)
    .where(and(eq(docVersions.id, snapshotId), eq(docVersions.projectId, projectId)))
    .limit(1);
  if (!row) throw new NotFoundError('Version not found');
  const { doc, ...summary } = row;
  return { summary, doc: doc as DesignDoc };
}

/** Restore a snapshot: auto-snapshot the current state, then apply replace ops as one transaction. */
export async function restoreSnapshot(
  db: Db,
  actor: Actor,
  projectId: string,
  snapshotId: string,
): Promise<CommitResult & { backupId: string }> {
  assertCan(actor.role, 'design:edit');
  const { doc: target } = await getSnapshotDoc(db, actor, projectId, snapshotId);
  const backup = await createSnapshot(db, actor, projectId, {
    kind: 'auto',
    description: `Before restoring version ${snapshotId}`,
  });
  const current = await getDoc(db, actor, projectId);
  const result = await commitTransaction(db, actor, projectId, {
    baseVersion: current.version,
    txn: {
      id: `restore-${newId('s').slice(2)}`,
      source: 'restore',
      label: 'Restore version',
      ops: replaceDocOps(current.doc, target),
    },
  });
  await db
    .update(docVersions)
    .set({ restoredFromId: snapshotId })
    .where(eq(docVersions.id, backup.id));
  return { ...result, backupId: backup.id };
}
