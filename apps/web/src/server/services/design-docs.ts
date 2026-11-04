/**
 * DesignDoc persistence (Story 2.5).
 *
 * - design_docs holds the materialized current doc and version; doc_ops is the append-only
 *   transaction log (audit, undo across sessions, catch-up for viewers).
 * - Writes are optimistic: the client sends `baseVersion`, and a stale base is rejected with
 *   ConflictError (never silently merged).
 * - Transactions are idempotent by `txn.id`: retrying a committed txn returns its version.
 * - Writes respect the soft edit lock (Story 3.8): if another user holds a live lock, the write
 *   is rejected with LockedError. Acquiring/heartbeating locks is the canvas stream's job.
 */
import { assertCan } from '@crunch/authz';
import { and, designDocs, docOps, editLocks, eq, gt, projects, sql, type Db } from '@crunch/db';
import {
  applyOps,
  checkInvariants,
  DocValidationError,
  initialDoc,
  OpError,
  parseDoc,
  transaction as transactionSchema,
  type DesignDoc,
  type Transaction,
} from '@crunch/doc-model';
import { getProject } from './projects';
import { NotFoundError, ValidationError, type Actor } from './types';

/** A lock is live if its heartbeat is newer than this (Story 3.8 AC: 2 minutes). */
export const EDIT_LOCK_TTL_MS = 2 * 60 * 1000;
/** Upper bound on stored doc size (JSON characters). */
export const MAX_DOC_BYTES = 8 * 1024 * 1024;

export class ConflictError extends Error {
  override name = 'ConflictError';
  constructor(public readonly currentVersion: number) {
    super(`Document changed (now at version ${currentVersion}); reload and retry`);
  }
}

export class LockedError extends Error {
  override name = 'LockedError';
  constructor(public readonly holderUserId: string) {
    super('Another member is editing this project');
  }
}

export interface DocState {
  projectId: string;
  version: number;
  doc: DesignDoc;
}

/** Create the initial doc row if the project has none yet. */
async function ensureDoc(db: Db, actor: Actor, projectId: string): Promise<void> {
  await db
    .insert(designDocs)
    .values({ projectId, workspaceId: actor.workspace.id, version: 0, doc: initialDoc() })
    .onConflictDoNothing();
}

export async function getDoc(db: Db, actor: Actor, projectId: string): Promise<DocState> {
  assertCan(actor.role, 'project:read');
  await getProject(db, actor, projectId); // workspace scoping (NotFound for other workspaces)
  let [row] = await db
    .select()
    .from(designDocs)
    .where(eq(designDocs.projectId, projectId))
    .limit(1);
  if (!row) {
    await ensureDoc(db, actor, projectId);
    [row] = await db.select().from(designDocs).where(eq(designDocs.projectId, projectId)).limit(1);
  }
  return { projectId, version: row!.version, doc: row!.doc as DesignDoc };
}

/** Throws LockedError if a live lock on the project is held by a different user. */
export async function assertNotLockedByOther(
  db: Db,
  actor: Actor,
  projectId: string,
): Promise<void> {
  // Compare against the database clock: heartbeat_at is written by Postgres (defaultNow()), so
  // mixing in the app server's clock (Date.now()) breaks under clock skew between the two.
  const [lock] = await db
    .select({ holder: editLocks.holderUserId })
    .from(editLocks)
    .where(
      and(
        eq(editLocks.projectId, projectId),
        sql`${editLocks.heartbeatAt} > now() - make_interval(secs => ${EDIT_LOCK_TTL_MS / 1000})`,
      ),
    )
    .limit(1);
  if (lock && lock.holder !== actor.userId) throw new LockedError(lock.holder);
}

export interface CommitInput {
  baseVersion: number;
  txn: unknown;
  /** For agent transactions: the agent message that produced it. */
  agentMessageId?: string;
}

export interface CommitResult {
  version: number;
  txnId: string;
  /** True if this txn id was already committed (idempotent retry). */
  duplicate: boolean;
}

export async function commitTransaction(
  db: Db,
  actor: Actor,
  projectId: string,
  input: CommitInput,
): Promise<CommitResult> {
  assertCan(actor.role, 'design:edit');
  const parsed = transactionSchema.safeParse(input.txn);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid transaction: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    );
  }
  const txn: Transaction = parsed.data;
  if (txn.source === 'agent' && !input.agentMessageId) {
    throw new ValidationError('Agent transactions must reference an agent message');
  }
  await getProject(db, actor, projectId);
  await ensureDoc(db, actor, projectId);
  await assertNotLockedByOther(db, actor, projectId);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ version: docOps.version })
      .from(docOps)
      .where(and(eq(docOps.projectId, projectId), eq(docOps.txnId, txn.id)))
      .limit(1);
    if (existing) return { version: existing.version, txnId: txn.id, duplicate: true };

    const [row] = await tx
      .select()
      .from(designDocs)
      .where(eq(designDocs.projectId, projectId))
      .for('update')
      .limit(1);
    if (!row) throw new NotFoundError('Document not found');
    if (row.version !== input.baseVersion) throw new ConflictError(row.version);

    let result;
    try {
      result = applyOps(row.doc as DesignDoc, txn.ops);
    } catch (e) {
      if (e instanceof OpError) throw new ValidationError(e.message);
      throw e;
    }
    const issues = checkInvariants(result.doc);
    if (issues.length) throw new ValidationError(new DocValidationError(issues).message);
    const json = JSON.stringify(result.doc);
    if (json.length > MAX_DOC_BYTES) throw new ValidationError('Document is too large');

    const version = row.version + 1;
    await tx.insert(docOps).values({
      projectId,
      workspaceId: actor.workspace.id,
      version,
      txnId: txn.id,
      ops: txn.ops,
      inverse: result.inverse,
      actorType: txn.source === 'agent' ? 'agent' : 'user',
      actorId: actor.userId,
      source: txn.source,
      agentMessageId: input.agentMessageId ?? null,
      label: txn.label ?? null,
    });
    await tx
      .update(designDocs)
      .set({ doc: result.doc, version, updatedBy: actor.userId })
      .where(eq(designDocs.projectId, projectId));
    await tx.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId));
    return { version, txnId: txn.id, duplicate: false };
  });
}

export interface OpsSince {
  version: number;
  txns: { version: number; txnId: string; ops: unknown[]; source: string; actorId: string }[];
  /** True when the client is too far behind; it should refetch the full doc. */
  reset: boolean;
}

/** Transactions after `since`, for viewers and other tabs to catch up without refetching. */
export async function getOpsSince(
  db: Db,
  actor: Actor,
  projectId: string,
  since: number,
  limit = 200,
): Promise<OpsSince> {
  assertCan(actor.role, 'project:read');
  const state = await getDoc(db, actor, projectId);
  if (since >= state.version) return { version: state.version, txns: [], reset: false };
  if (state.version - since > limit) return { version: state.version, txns: [], reset: true };
  const rows = await db
    .select({
      version: docOps.version,
      txnId: docOps.txnId,
      ops: docOps.ops,
      source: docOps.source,
      actorId: docOps.actorId,
    })
    .from(docOps)
    .where(and(eq(docOps.projectId, projectId), gt(docOps.version, since)))
    .orderBy(docOps.version);
  // A gap means history was trimmed (retention); fall back to a full refetch.
  const contiguous = rows.every((r, i) => r.version === since + i + 1);
  if (!contiguous) return { version: state.version, txns: [], reset: true };
  return {
    version: state.version,
    txns: rows.map((r) => ({ ...r, ops: r.ops as unknown[] })),
    reset: false,
  };
}

/** Copy a project's doc into another project (duplicate). */
export async function copyDoc(
  db: Db,
  actor: Actor,
  fromProjectId: string,
  toProjectId: string,
): Promise<void> {
  const { doc } = await getDoc(db, actor, fromProjectId);
  await db
    .insert(designDocs)
    .values({
      projectId: toProjectId,
      workspaceId: actor.workspace.id,
      version: 0,
      doc: parseDoc(doc),
    })
    .onConflictDoUpdate({ target: designDocs.projectId, set: { doc, version: 0 } });
}

/** Total transactions stored for a project (admin/debug). */
export async function opCount(db: Db, projectId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(docOps)
    .where(eq(docOps.projectId, projectId));
  return r?.n ?? 0;
}
