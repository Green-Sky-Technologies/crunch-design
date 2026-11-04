import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@crunch/authz';
import { activity, eq, notifications } from '@crunch/db';
import { newId, type DocOp } from '@crunch/doc-model';
import {
  createThread,
  linkAgentConversation,
  listMentionableMembers,
  listNotifications,
  listThreads,
  markNotificationsRead,
  replyToThread,
  setThreadStatus,
  updateThreadFallback,
} from '@/server/services/comments';
import { commitTransaction, getDoc } from '@/server/services/design-docs';
import { createProject } from '@/server/services/projects';
import { NotFoundError, ValidationError, type Actor } from '@/server/services/types';
import { upsertMember } from '@/server/services/workspaces';
import { makeActor, reset, testDb } from './helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

const box = (id: string, parentId: string) => ({
  id,
  type: 'box' as const,
  tag: 'div' as const,
  parentId,
  children: [],
  positioning: 'flow' as const,
  style: {},
  props: {},
});

async function commit(actor: Actor, projectId: string, ops: DocOp[]) {
  const { version } = await getDoc(db, actor, projectId);
  return commitTransaction(db, actor, projectId, {
    baseVersion: version,
    txn: { id: `t_${newId('s').slice(2)}`, source: 'canvas', ops },
  });
}

async function setup() {
  const editor = await makeActor(db, 'editor');
  await upsertMember(db, editor.workspace.id, editor.userId, 'editor');
  const viewer = await makeActor(db, 'viewer', editor.workspace);
  await upsertMember(db, editor.workspace.id, viewer.userId, 'viewer');
  const project = await createProject(db, editor, { name: 'P' });
  const { doc } = await getDoc(db, editor, project.id);
  const frame = doc.frames[0]!;
  const rootId = frame.rootNodeId;
  await commit(editor, project.id, [
    { op: 'insertSubtree', parentId: rootId, index: 0, nodes: [box('n_cardA00001', rootId)] },
    { op: 'insertSubtree', parentId: rootId, index: 1, nodes: [box('n_cardB00001', rootId)] },
  ]);
  return { editor, viewer, project, frameId: frame.id, rootId };
}

const nodeAnchor = (frameId: string, nodeId = 'n_cardA00001') => ({
  type: 'node' as const,
  frameId,
  nodeId,
});

describe('comment threads', () => {
  it('creates a node-pinned thread and lists it with its comments', async () => {
    const { editor, project, frameId } = await setup();
    const t = await createThread(db, editor, {
      projectId: project.id,
      anchor: nodeAnchor(frameId),
      body: 'Make this pop',
      fallback: { x: 40, y: 60 },
    });
    expect(t.status).toBe('open');
    expect(t.kind).toBe('discussion');
    expect(t.orphaned).toBe(false);
    expect(t.fallback).toEqual({ x: 40, y: 60 });
    expect(t.comments.map((c) => c.body)).toEqual(['Make this pop']);

    const list = await listThreads(db, editor, project.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(t.id);
  });

  it('survives node moves and becomes orphaned (but visible) when the node is deleted', async () => {
    const { editor, project, frameId, rootId } = await setup();
    const t = await createThread(db, editor, {
      projectId: project.id,
      anchor: nodeAnchor(frameId),
      body: 'Pinned',
    });
    // Move card A into card B: the anchor follows the stable node id.
    await commit(editor, project.id, [
      { op: 'moveNode', id: 'n_cardA00001', parentId: 'n_cardB00001', index: 0 },
    ]);
    let [after] = await listThreads(db, editor, project.id);
    expect(after!.orphaned).toBe(false);
    expect(after!.anchor).toEqual(nodeAnchor(frameId));

    // Delete it: the thread stays, flagged orphaned, with its fallback position.
    await commit(editor, project.id, [{ op: 'removeNode', id: 'n_cardB00001' }]);
    [after] = await listThreads(db, editor, project.id);
    expect(after!.id).toBe(t.id);
    expect(after!.orphaned).toBe(true);
    expect(after!.fallback).not.toBeNull();
    expect(after!.comments).toHaveLength(1);
    void rootId;
  });

  it('keeps a thread live when its node moves to another frame', async () => {
    const { editor, project, frameId } = await setup();
    const t = await createThread(db, editor, {
      projectId: project.id,
      anchor: nodeAnchor(frameId),
      body: 'Follow me',
    });
    expect(t.currentFrameId).toBe(frameId);
    const mobileRoot = 'n_mobroot0001';
    await commit(editor, project.id, [
      {
        op: 'insertFrame',
        index: 1,
        frame: {
          id: 'f_mobile00001',
          name: 'Mobile',
          rootNodeId: mobileRoot,
          canvas: { x: 1400, y: 0 },
          width: 390,
          height: 800,
          previewBreakpoints: [],
        },
        nodes: [{ ...box(mobileRoot, 'n_cardA00001'), parentId: null }],
      },
      { op: 'moveNode', id: 'n_cardA00001', parentId: mobileRoot, index: 0 },
    ]);
    const [after] = await listThreads(db, editor, project.id);
    expect(after!.orphaned).toBe(false);
    expect(after!.currentFrameId).toBe('f_mobile00001');

    // A stale client frame id is corrected to the node's real frame on create.
    const created = await createThread(db, editor, {
      projectId: project.id,
      anchor: nodeAnchor(frameId), // card A is no longer in this frame
      body: 'Stale frame id',
    });
    expect(created.anchor).toMatchObject({ frameId: 'f_mobile00001' });
    expect(created.orphaned).toBe(false);
  });

  it('supports canvas-position threads, replies, resolve and reopen', async () => {
    const { editor, project } = await setup();
    const t = await createThread(db, editor, {
      projectId: project.id,
      anchor: { type: 'canvas', x: 1500, y: 20 },
      body: 'Empty space here',
    });
    expect(t.fallback).toEqual({ x: 1500, y: 20 });
    const replied = await replyToThread(db, editor, t.id, { body: 'Agreed' });
    expect(replied.comments.map((c) => c.body)).toEqual(['Empty space here', 'Agreed']);

    const resolved = await setThreadStatus(db, editor, t.id, 'resolved');
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedBy).toBe(editor.userId);
    expect(await listThreads(db, editor, project.id, { status: 'open' })).toHaveLength(0);
    const reopened = await setThreadStatus(db, editor, t.id, 'open');
    expect(reopened.status).toBe('open');
    expect(reopened.resolvedAt).toBeNull();

    const verbs = (await db.select().from(activity).where(eq(activity.projectId, project.id))).map(
      (r) => r.verb,
    );
    expect(verbs).toEqual(
      expect.arrayContaining([
        'comment.created',
        'comment.replied',
        'comment.resolved',
        'comment.reopened',
      ]),
    );
  });

  it('rejects anchors to unknown nodes and empty bodies', async () => {
    const { editor, project, frameId } = await setup();
    await expect(
      createThread(db, editor, {
        projectId: project.id,
        anchor: nodeAnchor(frameId, 'n_missing0001'),
        body: 'x',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createThread(db, editor, { projectId: project.id, anchor: nodeAnchor(frameId), body: '  ' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('lets viewers read but never comment, reply or resolve', async () => {
    const { editor, viewer, project, frameId } = await setup();
    const t = await createThread(db, editor, {
      projectId: project.id,
      anchor: nodeAnchor(frameId),
      body: 'Hi',
    });
    expect(await listThreads(db, viewer, project.id)).toHaveLength(1);
    await expect(
      createThread(db, viewer, { projectId: project.id, anchor: nodeAnchor(frameId), body: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(replyToThread(db, viewer, t.id, { body: 'x' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(setThreadStatus(db, viewer, t.id, 'resolved')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(updateThreadFallback(db, viewer, t.id, { x: 0, y: 0 })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('reports threads and projects from other workspaces as not found', async () => {
    const { editor, project, frameId } = await setup();
    const t = await createThread(db, editor, {
      projectId: project.id,
      anchor: nodeAnchor(frameId),
      body: 'Hi',
    });
    const outsider = await makeActor(db, 'editor');
    await expect(listThreads(db, outsider, project.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(replyToThread(db, outsider, t.id, { body: 'x' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(setThreadStatus(db, outsider, t.id, 'resolved')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      createThread(db, outsider, {
        projectId: project.id,
        anchor: nodeAnchor(frameId),
        body: 'x',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(replyToThread(db, outsider, 'not-a-uuid', { body: 'x' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('creates notifications for mentioned members only', async () => {
    const { editor, viewer, project, frameId } = await setup();
    const outsider = await makeActor(db, 'editor');
    await upsertMember(db, outsider.workspace.id, outsider.userId, 'editor');

    const t = await createThread(db, editor, {
      projectId: project.id,
      anchor: nodeAnchor(frameId),
      body: '@viewer look',
      mentions: [viewer.userId, outsider.userId, editor.userId],
    });
    expect(t.comments[0]!.mentions).toEqual([viewer.userId]);

    const mine = await listNotifications(db, viewer);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.kind).toBe('mention');
    expect(mine[0]!.data).toMatchObject({ threadId: t.id, by: editor.userId });
    expect(await listNotifications(db, editor)).toHaveLength(0);
    expect(await listNotifications(db, outsider)).toHaveLength(0);

    await replyToThread(db, editor, t.id, { body: 'again', mentions: [viewer.userId] });
    expect(await listNotifications(db, viewer, { unreadOnly: true })).toHaveLength(2);

    // Someone else can't mark my notifications read.
    expect((await markNotificationsRead(db, editor, 'all')).updated).toBe(0);
    expect((await markNotificationsRead(db, viewer, [mine[0]!.id])).updated).toBe(1);
    expect(await listNotifications(db, viewer, { unreadOnly: true })).toHaveLength(1);
    expect((await markNotificationsRead(db, viewer, 'all')).updated).toBe(1);
    const rows = await db.select().from(notifications);
    expect(rows.every((r) => r.readAt !== null)).toBe(true);
  });

  it('lists mentionable members of the caller workspace only', async () => {
    const { editor, viewer } = await setup();
    const outsider = await makeActor(db, 'editor');
    await upsertMember(db, outsider.workspace.id, outsider.userId, 'editor');
    const ids = (await listMentionableMembers(db, editor)).map((m) => m.userId).sort();
    expect(ids).toEqual([editor.userId, viewer.userId].sort());
  });

  it('links agent conversations only to ask-agent threads', async () => {
    const { editor, project, frameId } = await setup();
    const discussion = await createThread(db, editor, {
      projectId: project.id,
      anchor: nodeAnchor(frameId),
      body: 'Hi',
    });
    const ask = await createThread(db, editor, {
      projectId: project.id,
      anchor: nodeAnchor(frameId),
      body: 'Make the card wider',
      kind: 'agent_request',
    });
    expect(ask.kind).toBe('agent_request');
    const cid = crypto.randomUUID();
    expect((await linkAgentConversation(db, editor, ask.id, cid)).agentConversationId).toBe(cid);
    await expect(linkAgentConversation(db, editor, discussion.id, cid)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(linkAgentConversation(db, editor, ask.id, 'nope')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('updates the remembered fallback position', async () => {
    const { editor, project, frameId } = await setup();
    const t = await createThread(db, editor, {
      projectId: project.id,
      anchor: nodeAnchor(frameId),
      body: 'Hi',
    });
    await updateThreadFallback(db, editor, t.id, { x: 12, y: 34 });
    const [after] = await listThreads(db, editor, project.id);
    expect(after!.fallback).toEqual({ x: 12, y: 34 });
    await expect(updateThreadFallback(db, editor, t.id, { x: 'a' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
