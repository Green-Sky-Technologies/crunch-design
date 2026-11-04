import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { activity, docOps, eq, sql, users } from '@crunch/db';
import { newId, replaceDocOps, sampleLandingDoc, type DocOp } from '@crunch/doc-model';
import { describeEntry, type FeedItem } from '@/features/collab/activity-panel';
import { EDIT_GROUP_WINDOW_MS, groupEdits, listActivity } from '@/server/services/activity';
import { createThread } from '@/server/services/comments';
import { commitTransaction, getDoc } from '@/server/services/design-docs';
import { createProject } from '@/server/services/projects';
import { NotFoundError, ValidationError, type Actor } from '@/server/services/types';
import { createNamedVersion } from '@/server/services/versions';
import { makeActor, reset, testDb } from './helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

async function commit(
  actor: Actor,
  projectId: string,
  ops: DocOp[],
  source: 'canvas' | 'agent' | 'inspector' = 'canvas',
  label?: string,
) {
  const { version } = await getDoc(db, actor, projectId);
  return commitTransaction(db, actor, projectId, {
    baseVersion: version,
    txn: { id: `t_${newId('s').slice(2)}`, source, label, ops },
    agentMessageId: source === 'agent' ? crypto.randomUUID() : undefined,
  });
}

const setText = (text: string): DocOp[] => [
  { op: 'setProps', id: 'n_herotitle1', patch: { text } },
];

async function setup() {
  const editor = await makeActor(db, 'editor');
  await db.insert(users).values({ id: editor.userId, name: 'Ann Editor' });
  const viewer = await makeActor(db, 'viewer', editor.workspace);
  const project = await createProject(db, editor, { name: 'P' });
  const { doc } = await getDoc(db, editor, project.id);
  await commit(editor, project.id, replaceDocOps(doc, sampleLandingDoc()), 'canvas', 'Sample');
  return { editor, viewer, project };
}

describe('activity feed', () => {
  it('merges design edits (human vs. agent) with collaboration activity, newest first', async () => {
    const { editor, viewer, project } = await setup();
    await commit(editor, project.id, setText('A'), 'inspector', 'Edit headline');
    await commit(editor, project.id, setText('B'), 'agent', 'Agent tweak');
    await createNamedVersion(db, editor, project.id, { name: 'Milestone' });
    const frameId = sampleLandingDoc().frames[0]!.id;
    await createThread(db, editor, {
      projectId: project.id,
      anchor: { type: 'node', frameId, nodeId: 'n_herotitle1' },
      body: 'Nice',
    });

    const { entries } = await listActivity(db, viewer, project.id);
    expect(entries.map((e) => e.verb)).toEqual([
      'comment.created',
      'version.named',
      'doc.edited', // agent
      'doc.edited', // human (2 txns grouped)
    ]);
    const [, , agentEdit, humanEdit] = entries;
    expect(agentEdit!.actorType).toBe('agent');
    expect(agentEdit!.actorId).toBe(editor.userId);
    expect(agentEdit!.edits).toMatchObject({ count: 1, sources: ['agent'] });
    expect(humanEdit!.actorType).toBe('user');
    expect(humanEdit!.actorName).toBe('Ann Editor');
    expect(humanEdit!.edits).toMatchObject({ count: 2, fromVersion: 1, toVersion: 2 });
    expect(humanEdit!.edits!.labels).toEqual(['Edit headline', 'Sample']);

    const agentOnly = await listActivity(db, viewer, project.id, { who: 'agent' });
    expect(agentOnly.entries.map((e) => e.verb)).toEqual(['doc.edited']);
    const human = await listActivity(db, viewer, project.id, { who: 'human' });
    expect(human.entries.every((e) => e.actorType !== 'agent')).toBe(true);
    expect(human.entries).toHaveLength(3);
  });

  it('paginates with a time cursor', async () => {
    const { editor, project } = await setup();
    for (let i = 0; i < 4; i++) await createNamedVersion(db, editor, project.id, { name: `v${i}` });
    const p1 = await listActivity(db, editor, project.id, { limit: 3 });
    expect(p1.entries).toHaveLength(3);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await listActivity(db, editor, project.id, {
      limit: 3,
      cursor: p1.nextCursor!,
    });
    const ids = [...p1.entries, ...p2.entries].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(5); // 4 versions + the initial edit
    expect(p2.nextCursor).toBeNull();
  });

  it('never repeats or skips a grouped edit that straddles a page boundary', async () => {
    const { editor, project } = await setup(); // 1 op (sample insert)
    // A burst of 7 more edits by the same user (one group), interleaved with activity rows.
    for (let i = 0; i < 7; i++) {
      await commit(editor, project.id, setText(`t${i}`));
      if (i % 3 === 0) await createNamedVersion(db, editor, project.id, { name: `v${i}` });
    }
    const totalOps = (await db.select().from(docOps).where(eq(docOps.projectId, project.id)))
      .length;
    expect(totalOps).toBe(8);
    // Tiny pages and a tiny op window force the group across several pages.
    const seen: string[] = [];
    let ops = 0;
    let versions = 0;
    let cursor: string | undefined;
    for (let pageNo = 0; pageNo < 50; pageNo++) {
      const p = await listActivity(db, editor, project.id, { limit: 2, opFetchFactor: 1, cursor });
      for (const e of p.entries) {
        seen.push(e.id);
        if (e.verb === 'doc.edited') ops += e.edits!.count;
        if (e.verb === 'version.named') versions++;
      }
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length); // no entry twice
    expect(ops).toBe(totalOps); // every op counted exactly once
    expect(versions).toBe(3);
  });

  it('pages at microsecond precision (rows within the same millisecond)', async () => {
    const { editor, project } = await setup();
    const at = (us: string) => sql`timestamptz '2026-01-01 00:00:00.${sql.raw(us)}+00'`;
    for (const us of ['000100', '000500', '000900'])
      await db.insert(activity).values({
        workspaceId: editor.workspace.id,
        projectId: project.id,
        actorType: 'user',
        actorId: editor.userId,
        verb: 'version.named',
        data: { name: us },
        createdAt: at(us) as unknown as Date,
      });
    const names: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const p = await listActivity(db, editor, project.id, { limit: 1, cursor, who: 'human' });
      for (const e of p.entries) if (e.verb === 'version.named') names.push(String(e.data.name));
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
    }
    expect(names).toEqual(['000900', '000500', '000100']);
  });

  it('rejects malformed cursors', async () => {
    const { editor, project } = await setup();
    await expect(
      listActivity(db, editor, project.id, { cursor: 'not-a-cursor' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('is scoped to the workspace', async () => {
    const { project } = await setup();
    const outsider = await makeActor(db, 'admin');
    await expect(listActivity(db, outsider, project.id)).rejects.toBeInstanceOf(NotFoundError);
    // doc_ops rows are only read for the caller's workspace.
    expect((await db.select().from(docOps).where(eq(docOps.projectId, project.id))).length).toBe(1);
  });
});

describe('groupEdits', () => {
  const row = (id: number, minutesAgo: number, actorId = 'u1', actorType = 'user' as const) => {
    const createdAt = new Date(Date.UTC(2026, 0, 1, 12) - minutesAgo * 60_000);
    return {
      id,
      version: id,
      actorType,
      actorId,
      source: 'canvas',
      label: null,
      createdAt,
      us: String(createdAt.getTime() * 1000),
    };
  };

  it('groups consecutive edits by the same actor inside the window', () => {
    const g = groupEdits([row(5, 0), row(4, 1), row(3, 2, 'u2'), row(2, 3), row(1, 3 + 6)]);
    expect(g[0]!.head[1]).toBe(5);
    expect(g[0]!.tail[1]).toBe(4); // resume after the oldest op of the group
    expect(g.map(({ entry: e }) => [e.actorId, e.edits!.count])).toEqual([
      ['u1', 2],
      ['u2', 1],
      ['u1', 1],
      ['u1', 1],
    ]);
    expect(EDIT_GROUP_WINDOW_MS).toBe(5 * 60_000);
  });

  it('never groups agent and human edits together', () => {
    const g = groupEdits([row(2, 0, 'u1', 'user'), { ...row(1, 0), actorType: 'agent' as const }]);
    expect(g).toHaveLength(2);
  });
});

describe('describeEntry', () => {
  const base: FeedItem = {
    id: 'x',
    at: new Date().toISOString(),
    actorType: 'user',
    actorId: 'u',
    actorName: 'A',
    verb: 'doc.edited',
    targetType: null,
    targetId: null,
    data: {},
  };
  it('describes edits and activity verbs', () => {
    expect(
      describeEntry({
        ...base,
        edits: {
          count: 3,
          sources: ['canvas', 'slider'],
          labels: [],
          fromVersion: 1,
          toVersion: 3,
        },
      }),
    ).toBe('edited the design (3 changes via canvas, sliders)');
    expect(describeEntry({ ...base, verb: 'version.named', data: { name: 'V1' } })).toBe(
      'saved version “V1”',
    );
    expect(describeEntry({ ...base, verb: 'share.created', data: { visibility: 'public' } })).toBe(
      'created a public share link',
    );
  });
});
