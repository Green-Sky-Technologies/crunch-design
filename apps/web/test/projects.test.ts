import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@crunch/authz';
import {
  createProject,
  duplicateProject,
  getProject,
  listProjects,
  renameProject,
  setProjectArchived,
} from '@/server/services/projects';
import { NotFoundError, ValidationError } from '@/server/services/types';
import { makeActor, reset, testDb } from './helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

describe('projects', () => {
  it('editors create, rename, duplicate, archive and restore', async () => {
    const editor = await makeActor(db, 'editor');
    const p = await createProject(db, editor, { name: '  Landing page ' });
    expect(p.name).toBe('Landing page');
    expect(p.designSystemId).toBeTruthy();

    await renameProject(db, editor, p.id, 'Marketing site');
    const copy = await duplicateProject(db, editor, p.id);
    expect(copy.name).toBe('Marketing site (copy)');
    expect((await listProjects(db, editor)).map((x) => x.id).sort()).toEqual(
      [p.id, copy.id].sort(),
    );

    await setProjectArchived(db, editor, p.id, true);
    expect((await listProjects(db, editor)).map((x) => x.id)).toEqual([copy.id]);
    expect((await listProjects(db, editor, { archived: true })).map((x) => x.id)).toEqual([p.id]);
    await setProjectArchived(db, editor, p.id, false);
    expect(await listProjects(db, editor)).toHaveLength(2);
  });

  it('viewers can read but not create or modify', async () => {
    const editor = await makeActor(db, 'editor');
    const viewer = await makeActor(db, 'viewer', editor.workspace);
    const p = await createProject(db, editor, { name: 'X' });
    expect((await getProject(db, viewer, p.id)).id).toBe(p.id);
    await expect(createProject(db, viewer, { name: 'nope' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(renameProject(db, viewer, p.id, 'nope')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setProjectArchived(db, viewer, p.id, true)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(duplicateProject(db, viewer, p.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('projects are invisible across workspaces (no IDOR)', async () => {
    const a = await makeActor(db, 'admin');
    const b = await makeActor(db, 'admin');
    const p = await createProject(db, a, { name: 'Secret' });
    await expect(getProject(db, b, p.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(renameProject(db, b, p.id, 'pwn')).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProject(db, b, 'not-a-uuid')).rejects.toBeInstanceOf(NotFoundError);
    expect(await listProjects(db, b)).toHaveLength(0);
  });

  it('validates names', async () => {
    const editor = await makeActor(db, 'editor');
    await expect(createProject(db, editor, { name: '   ' })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(createProject(db, editor, { name: 'x'.repeat(121) })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe('design-system pinning (Story 4.2 integration)', () => {
  it('new projects pin the latest published version, and duplicates keep their pin', async () => {
    const editor = await makeActor(db, 'editor');
    const p = await createProject(db, editor, { name: 'Pinned' });
    expect(p.designSystemVersionId).toBeTruthy();
    const copy = await duplicateProject(db, editor, p.id);
    expect(copy.designSystemVersionId).toBe(p.designSystemVersionId);
  });
});
