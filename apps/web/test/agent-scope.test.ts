/** Scope enforcement on retries and for jobs, and the atomic auto snapshot (review #12, #13). */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { executeTool } from '@crunch/agent';
import { agentConversations, agentMessages, docVersions, eq } from '@crunch/db';
import type { Node } from '@crunch/doc-model';
import { snapshotBeforeAgentEdit } from '@/server/services/agent/snapshots';
import { createDbToolHost } from '@/server/services/agent/tool-host';
import { jobFrameScope } from '@/server/services/agent/job-mcp';
import { commitTransaction, getDoc } from '@/server/services/design-docs';
import { createProject } from '@/server/services/projects';
import { makeActor, reset, testDb } from './helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

const box = (id: string, parentId: string, children: string[] = []): Node => ({
  id,
  type: 'box',
  tag: 'div',
  parentId,
  children,
  positioning: 'flow',
  style: {},
  props: {},
});

async function setup() {
  const editor = await makeActor(db, 'editor');
  const project = await createProject(db, editor, { name: 'P' });
  const { doc } = await getDoc(db, editor, project.id);
  const root = doc.frames[0]!.rootNodeId;
  await commitTransaction(db, editor, project.id, {
    baseVersion: 0,
    txn: {
      id: 'seed-scope-01',
      source: 'canvas',
      ops: [
        {
          op: 'insertSubtree',
          parentId: root,
          index: 0,
          nodes: [box('n_scoperoot1', root, ['n_innernode1']), box('n_innernode1', 'n_scoperoot1')],
        },
        { op: 'insertSubtree', parentId: root, index: 1, nodes: [box('n_elsewhere1', root)] },
      ],
    },
  });
  const [conv] = await db
    .insert(agentConversations)
    .values({ workspaceId: editor.workspace.id, projectId: project.id, createdBy: editor.userId })
    .returning();
  const [msg] = await db
    .insert(agentMessages)
    .values({
      conversationId: conv!.id,
      workspaceId: editor.workspace.id,
      seq: 1,
      role: 'assistant',
      content: {},
    })
    .returning();
  return { editor, project, root, frameId: doc.frames[0]!.id, messageId: msg!.id };
}

describe('scope on conflict retry', () => {
  it('re-checks scope against the fresh doc when another write lands first', async () => {
    const { editor, project, root, messageId } = await setup();
    const host = await createDbToolHost(db, editor, {
      projectId: project.id,
      agentMessageId: messageId,
      runtime: 'interactive',
      scope: { rootNodeId: 'n_scoperoot1', allowWider: false },
    });
    await host.getDoc(); // the agent read the doc while n_innernode1 was in scope
    // Meanwhile a user moves that node out of the scoped subtree.
    await commitTransaction(db, editor, project.id, {
      baseVersion: 1,
      txn: {
        id: 'user-move-001',
        source: 'canvas',
        ops: [{ op: 'moveNode', id: 'n_innernode1', parentId: root, index: 0 }],
      },
    });
    const r = await executeTool(host, 'patch_nodes', {
      label: 'x',
      ops: [{ op: 'setStyle', id: 'n_innernode1', breakpoint: 'base', prop: 'gap', value: 4 }],
    });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content).error).toMatch(/Out of scope/);
    expect(
      (await getDoc(db, editor, project.id)).doc.nodes['n_innernode1']!.style.base,
    ).toBeUndefined();
  });
});

describe('job frame scope', () => {
  it('a redesign job cannot touch frames outside its targets, even through the DB host', async () => {
    const { editor, project, frameId, messageId } = await setup();
    const host = await createDbToolHost(db, editor, {
      projectId: project.id,
      agentMessageId: messageId,
      runtime: 'job',
      frameScope: jobFrameScope('redesign', { prompt: 'x', frameIds: ['f_someother1'] }, []),
    });
    const r = await executeTool(host, 'patch_nodes', {
      label: 'x',
      ops: [{ op: 'setStyle', id: 'n_elsewhere1', breakpoint: 'base', prop: 'gap', value: 4 }],
    });
    expect(JSON.parse(r.content).error).toMatch(/outside this job's frames/);
    expect(jobFrameScope('redesign', { prompt: 'x', frameIds: [frameId] }, [])).toMatchObject({
      frameIds: [frameId],
      allowNewFrames: false,
    });
    expect(
      jobFrameScope('alternatives', { prompt: '', frameId, count: 2 }, ['f_alt']),
    ).toMatchObject({ frameIds: [], createdFrameIds: ['f_alt'], allowNewFrames: true });
    expect(jobFrameScope('codegen', { target: 'react-tailwind' }, [])).toBeUndefined();
  });
});

describe('auto snapshot atomicity', () => {
  it('parallel callers take exactly one snapshot', async () => {
    const { editor, project, messageId } = await setup();
    const ids = await Promise.all(
      [1, 2, 3].map(() => snapshotBeforeAgentEdit(db, editor, project.id, messageId)),
    );
    expect(new Set(ids).size).toBe(1);
    const rows = await db
      .select()
      .from(docVersions)
      .where(eq(docVersions.agentMessageId, messageId));
    expect(rows).toHaveLength(1);
    const [msg] = await db.select().from(agentMessages).where(eq(agentMessages.id, messageId));
    expect(msg!.snapshotVersionId).toBe(ids[0]);
  });
});
