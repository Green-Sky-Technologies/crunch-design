import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@crunch/authz';
import { editLocks, eq, docOps } from '@crunch/db';
import { checkInvariants, newId, type DocOp } from '@crunch/doc-model';
import {
  commitTransaction,
  ConflictError,
  copyDoc,
  getDoc,
  getOpsSince,
  LockedError,
} from '@/server/services/design-docs';
import { createProject, duplicateProject, setProjectArchived } from '@/server/services/projects';
import {
  createSnapshot,
  getSnapshotDoc,
  listSnapshots,
  restoreSnapshot,
} from '@/server/services/snapshots';
import { NotFoundError, ValidationError } from '@/server/services/types';
import { makeActor, reset, testDb } from './helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

const txn = (ops: DocOp[], source = 'canvas') => ({ id: `t_${newId('s').slice(2)}`, source, ops });

async function setup() {
  const editor = await makeActor(db, 'editor');
  const project = await createProject(db, editor, { name: 'P' });
  const state = await getDoc(db, editor, project.id);
  const frame = state.doc.frames[0]!;
  return { editor, project, state, rootId: frame.rootNodeId };
}

const heading = (id: string, parentId: string, text = 'Hello') => ({
  id,
  type: 'text' as const,
  tag: 'h1' as const,
  parentId,
  children: [],
  positioning: 'flow' as const,
  style: {},
  props: { text },
});

describe('design docs', () => {
  it('creates an initial valid doc lazily', async () => {
    const { state } = await setup();
    expect(state.version).toBe(0);
    expect(state.doc.frames).toHaveLength(1);
    expect(checkInvariants(state.doc)).toEqual([]);
  });

  it('commits transactions, bumps versions and logs inverse ops', async () => {
    const { editor, project, rootId } = await setup();
    const t = txn([
      { op: 'insertSubtree', parentId: rootId, index: 0, nodes: [heading('n_h100000001', rootId)] },
    ]);
    const r = await commitTransaction(db, editor, project.id, { baseVersion: 0, txn: t });
    expect(r).toMatchObject({ version: 1, duplicate: false });
    const after = await getDoc(db, editor, project.id);
    expect(after.doc.nodes['n_h100000001']).toBeDefined();
    const [log] = await db.select().from(docOps).where(eq(docOps.projectId, project.id));
    expect(log).toMatchObject({ version: 1, txnId: t.id, source: 'canvas', actorType: 'user' });
    expect(log!.inverse).toEqual([{ op: 'removeNode', id: 'n_h100000001' }]);
  });

  it('is idempotent by txn id and rejects stale base versions', async () => {
    const { editor, project, rootId } = await setup();
    const t = txn([
      { op: 'insertSubtree', parentId: rootId, index: 0, nodes: [heading('n_h100000002', rootId)] },
    ]);
    await commitTransaction(db, editor, project.id, { baseVersion: 0, txn: t });
    expect(
      await commitTransaction(db, editor, project.id, { baseVersion: 0, txn: t }),
    ).toMatchObject({ version: 1, duplicate: true });
    const stale = txn([{ op: 'setNodeMeta', id: rootId, patch: { name: 'X' } }]);
    await expect(
      commitTransaction(db, editor, project.id, { baseVersion: 0, txn: stale }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('serializes concurrent commits on the same base (one wins, one conflicts)', async () => {
    const { editor, project, rootId } = await setup();
    const results = await Promise.allSettled(
      [1, 2].map((i) =>
        commitTransaction(db, editor, project.id, {
          baseVersion: 0,
          txn: txn([{ op: 'setNodeMeta', id: rootId, patch: { name: `Name ${i}` } }]),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictError);
  });

  it('rejects invalid ops atomically and never stores an invalid doc', async () => {
    const { editor, project, rootId } = await setup();
    const bad = txn([
      { op: 'setNodeMeta', id: rootId, patch: { name: 'ok' } },
      { op: 'setStyle', id: rootId, breakpoint: 'base', prop: 'color', value: 'red;}' },
    ]);
    await expect(
      commitTransaction(db, editor, project.id, { baseVersion: 0, txn: bad }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await getDoc(db, editor, project.id)).version).toBe(0);
    await expect(
      commitTransaction(db, editor, project.id, { baseVersion: 0, txn: { nope: true } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      commitTransaction(db, editor, project.id, {
        baseVersion: 0,
        txn: txn([{ op: 'setNodeMeta', id: rootId, patch: { name: 'x' } }], 'agent'),
      }),
    ).rejects.toThrow(/agent message/);
  });

  it('enforces roles, workspace scoping and other users’ live locks', async () => {
    const { editor, project, rootId } = await setup();
    const viewer = await makeActor(db, 'viewer', editor.workspace);
    const other = await makeActor(db, 'editor', editor.workspace);
    const outsider = await makeActor(db, 'admin');
    const t = () => txn([{ op: 'setNodeMeta', id: rootId, patch: { name: 'n' } }]);

    expect((await getDoc(db, viewer, project.id)).version).toBe(0);
    await expect(
      commitTransaction(db, viewer, project.id, { baseVersion: 0, txn: t() }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getDoc(db, outsider, project.id)).rejects.toBeInstanceOf(NotFoundError);

    await db.insert(editLocks).values({
      projectId: project.id,
      workspaceId: editor.workspace.id,
      holderUserId: editor.userId,
      sessionId: 's1',
    });
    await expect(
      commitTransaction(db, other, project.id, { baseVersion: 0, txn: t() }),
    ).rejects.toBeInstanceOf(LockedError);
    await commitTransaction(db, editor, project.id, { baseVersion: 0, txn: t() }); // holder can write
    // An expired lock doesn't block.
    await db
      .update(editLocks)
      .set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(editLocks.projectId, project.id));
    await commitTransaction(db, other, project.id, { baseVersion: 1, txn: t() });
  });

  it('serves ops since a version for catch-up', async () => {
    const { editor, project, rootId } = await setup();
    for (let v = 0; v < 3; v++) {
      await commitTransaction(db, editor, project.id, {
        baseVersion: v,
        txn: txn([{ op: 'setNodeMeta', id: rootId, patch: { name: `v${v}` } }]),
      });
    }
    const r = await getOpsSince(db, editor, project.id, 1);
    expect(r).toMatchObject({ version: 3, reset: false });
    expect(r.txns.map((t) => t.version)).toEqual([2, 3]);
    expect((await getOpsSince(db, editor, project.id, 3)).txns).toEqual([]);
    expect((await getOpsSince(db, editor, project.id, 0, 2)).reset).toBe(true);
  });

  it('duplicating a project can copy its doc', async () => {
    const { editor, project, rootId } = await setup();
    await commitTransaction(db, editor, project.id, {
      baseVersion: 0,
      txn: txn([
        {
          op: 'insertSubtree',
          parentId: rootId,
          index: 0,
          nodes: [heading('n_h100000003', rootId, 'Copied')],
        },
      ]),
    });
    const copy = await duplicateProject(db, editor, project.id);
    await copyDoc(db, editor, project.id, copy.id);
    const d = await getDoc(db, editor, copy.id);
    expect(d.version).toBe(0);
    expect(d.doc.nodes['n_h100000003']).toBeDefined();
  });
});

describe('snapshots', () => {
  it('named versions, restore with auto backup, and history is preserved', async () => {
    const { editor, project, rootId } = await setup();
    await commitTransaction(db, editor, project.id, {
      baseVersion: 0,
      txn: txn([
        {
          op: 'insertSubtree',
          parentId: rootId,
          index: 0,
          nodes: [heading('n_h100000004', rootId, 'V1')],
        },
      ]),
    });
    const v1 = await createSnapshot(db, editor, project.id, { kind: 'named', name: 'First draft' });
    expect(v1).toMatchObject({ kind: 'named', name: 'First draft', docVersion: 1 });
    expect(v1).not.toHaveProperty('doc');

    await commitTransaction(db, editor, project.id, {
      baseVersion: 1,
      txn: txn([{ op: 'setProps', id: 'n_h100000004', patch: { text: 'V2' } }]),
    });
    const restored = await restoreSnapshot(db, editor, project.id, v1.id);
    expect(restored.version).toBe(3);
    const now = await getDoc(db, editor, project.id);
    expect((now.doc.nodes['n_h100000004'] as { props: { text: string } }).props.text).toBe('V1');

    const all = await listSnapshots(db, editor, project.id);
    expect(all.map((s) => s.kind).sort()).toEqual(['auto', 'named']);
    const backup = await getSnapshotDoc(db, editor, project.id, restored.backupId);
    expect((backup.doc.nodes['n_h100000004'] as { props: { text: string } }).props.text).toBe('V2');
  });

  it('validates names and permissions', async () => {
    const { editor, project } = await setup();
    const viewer = await makeActor(db, 'viewer', editor.workspace);
    await expect(
      createSnapshot(db, editor, project.id, { kind: 'named', name: ' ' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createSnapshot(db, viewer, project.id, { kind: 'named', name: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await listSnapshots(db, viewer, project.id)).toEqual([]);
    await expect(getSnapshotDoc(db, editor, project.id, 'nope')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('rejects edits to archived projects until they are restored', async () => {
    const { editor, project, rootId } = await setup();
    await setProjectArchived(db, editor, project.id, true);
    await expect(
      commitTransaction(db, editor, project.id, {
        baseVersion: 0,
        txn: txn([{ op: 'setNodeMeta', id: rootId, patch: { name: 'x' } }]),
      }),
    ).rejects.toThrow(/archived/);
    await setProjectArchived(db, editor, project.id, false);
    await commitTransaction(db, editor, project.id, {
      baseVersion: 0,
      txn: txn([{ op: 'setNodeMeta', id: rootId, patch: { name: 'x' } }]),
    });
  });
});
