import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@crunch/authz';
import { activity, docVersions, eq } from '@crunch/db';
import { newId, sampleLandingDoc, replaceDocOps, type DocOp } from '@crunch/doc-model';
import { diffDocs } from '@/features/collab/version-diff';
import { commitTransaction, getDoc } from '@/server/services/design-docs';
import { createProject } from '@/server/services/projects';
import { NotFoundError, ValidationError, type Actor } from '@/server/services/types';
import {
  createNamedVersion,
  getVersion,
  listVersions,
  restoreVersion,
} from '@/server/services/versions';
import { makeActor, reset, testDb } from './helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

async function commit(actor: Actor, projectId: string, ops: DocOp[]) {
  const { version } = await getDoc(db, actor, projectId);
  return commitTransaction(db, actor, projectId, {
    baseVersion: version,
    txn: { id: `t_${newId('s').slice(2)}`, source: 'canvas', ops },
  });
}

async function setup() {
  const editor = await makeActor(db, 'editor');
  const viewer = await makeActor(db, 'viewer', editor.workspace);
  const project = await createProject(db, editor, { name: 'P' });
  const { doc } = await getDoc(db, editor, project.id);
  await commit(editor, project.id, replaceDocOps(doc, sampleLandingDoc()));
  return { editor, viewer, project };
}

const heroText = 'n_herotitle1';

describe('named versions', () => {
  it('saves, lists and loads a named version', async () => {
    const { editor, viewer, project } = await setup();
    const v = await createNamedVersion(db, editor, project.id, {
      name: '  Launch draft ',
      description: 'Before review',
    });
    expect(v.name).toBe('Launch draft');
    expect(v.kind).toBe('named');

    const list = await listVersions(db, viewer, project.id);
    expect(list.map((x) => x.id)).toEqual([v.id]);
    const loaded = await getVersion(db, viewer, project.id, v.id);
    expect(loaded.doc.frames).toHaveLength(sampleLandingDoc().frames.length);

    const [row] = await db.select().from(activity).where(eq(activity.targetId, v.id));
    expect(row?.verb).toBe('version.named');
  });

  it('requires a name and design:edit', async () => {
    const { editor, viewer, project } = await setup();
    await expect(createNamedVersion(db, editor, project.id, { name: ' ' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(createNamedVersion(db, viewer, project.id, { name: 'x' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('restores as a new doc version and never destroys history', async () => {
    const { editor, viewer, project } = await setup();
    const doc0 = (await getDoc(db, editor, project.id)).doc;
    const v1 = await createNamedVersion(db, editor, project.id, { name: 'v1' });
    const textBefore = (doc0.nodes[heroText] as { props: { text: string } }).props.text;

    await commit(editor, project.id, [
      { op: 'setProps', id: heroText, patch: { text: 'Changed headline' } },
    ]);
    const before = await getDoc(db, editor, project.id);

    await expect(restoreVersion(db, viewer, project.id, v1.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const r = await restoreVersion(db, editor, project.id, v1.id);
    const after = await getDoc(db, editor, project.id);
    expect(after.version).toBe(before.version + 1);
    expect(r.version).toBe(after.version);
    expect((after.doc.nodes[heroText] as { props: { text: string } }).props.text).toBe(textBefore);

    // The named version is still there, plus an auto backup of the pre-restore state.
    const all = await listVersions(db, editor, project.id, { includeAuto: true });
    expect(all.map((x) => x.id)).toContain(v1.id);
    const backup = all.find((x) => x.id === r.backupId)!;
    expect(backup.kind).toBe('auto');
    expect(backup.restoredFromId).toBe(v1.id);
    const backupDoc = await getVersion(db, editor, project.id, backup.id);
    expect((backupDoc.doc.nodes[heroText] as { props: { text: string } }).props.text).toBe(
      'Changed headline',
    );
    // Named-only listing hides auto snapshots.
    expect((await listVersions(db, editor, project.id)).map((x) => x.id)).toEqual([v1.id]);
    expect((await db.select().from(docVersions)).length).toBe(2);

    // Restoring the backup undoes the restore.
    await restoreVersion(db, editor, project.id, backup.id);
    const again = await getDoc(db, editor, project.id);
    expect((again.doc.nodes[heroText] as { props: { text: string } }).props.text).toBe(
      'Changed headline',
    );
  });

  it('scopes versions to the workspace and project', async () => {
    const { editor, project } = await setup();
    const v = await createNamedVersion(db, editor, project.id, { name: 'v' });
    const outsider = await makeActor(db, 'admin');
    await expect(listVersions(db, outsider, project.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getVersion(db, outsider, project.id, v.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(restoreVersion(db, outsider, project.id, v.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const other = await createProject(db, editor, { name: 'Other' });
    await expect(getVersion(db, editor, other.id, v.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getVersion(db, editor, project.id, 'junk')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('diffDocs', () => {
  it('reports added, removed and changed nodes per frame', async () => {
    const a = sampleLandingDoc();
    const frame = a.frames[0]!;
    const b = structuredClone(a);
    (b.nodes[heroText] as { props: { text: string } }).props.text = 'New';
    const removedId = b.nodes[frame.rootNodeId]!.children.at(-1)!;
    const d0 = diffDocs(a, a);
    expect(d0.every((f) => f.status === 'unchanged')).toBe(true);
    // Remove the last section of the root (and its subtree).
    const stack = [removedId];
    while (stack.length) {
      const id = stack.pop()!;
      stack.push(...b.nodes[id]!.children);
      delete b.nodes[id];
    }
    b.nodes[frame.rootNodeId]!.children = b.nodes[frame.rootNodeId]!.children.slice(0, -1);
    const [d] = diffDocs(a, b);
    expect(d!.status).toBe('changed');
    expect(d!.changed).toEqual(expect.arrayContaining([heroText, frame.rootNodeId]));
    expect(d!.removed).toContain(removedId);
    expect(d!.added).toEqual([]);

    const empty = { ...b, frames: [], nodes: {} };
    expect(diffDocs(empty, a)[0]!.status).toBe('added');
    expect(diffDocs(a, empty)[0]!.status).toBe('removed');
  });
});
