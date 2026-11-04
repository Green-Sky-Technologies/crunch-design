import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@crunch/authz';
import { executeTool } from '@crunch/agent';
import { agentConversations, agentMessages, docOps, eq } from '@crunch/db';
import type { Actor } from '@/server/services/types';
import { commitTransaction, getDoc } from '@/server/services/design-docs';
import { createProject } from '@/server/services/projects';
import { createDbToolHost } from '@/server/services/agent/tool-host';
import { makeActor, reset, testDb } from './helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

async function setup(role: Actor['role'] = 'editor') {
  const editor = await makeActor(db, 'editor');
  const project = await createProject(db, editor, { name: 'P' });
  const state = await getDoc(db, editor, project.id);
  const rootId = state.doc.frames[0]!.rootNodeId;
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
      content: [],
    })
    .returning();
  const actor = role === 'editor' ? editor : await makeActor(db, role, editor.workspace);
  return { editor, actor, project, rootId, messageId: msg!.id };
}

describe('DB tool host', () => {
  it('commits agent transactions attributed to the agent message', async () => {
    const { editor, project, rootId, messageId } = await setup();
    const host = await createDbToolHost(db, editor, {
      projectId: project.id,
      agentMessageId: messageId,
      runtime: 'interactive',
    });
    const r = await executeTool(host, 'patch_nodes', {
      label: 'Gap',
      ops: [{ op: 'setStyle', id: rootId, breakpoint: 'base', prop: 'gap', value: 24 }],
    });
    expect(r.isError).toBe(false);
    expect(r.touched).toEqual([rootId]);
    const [log] = await db.select().from(docOps).where(eq(docOps.projectId, project.id));
    expect(log).toMatchObject({
      source: 'agent',
      actorType: 'agent',
      agentMessageId: messageId,
      txnId: r.txnId,
      label: 'Gap',
    });
    const [msg] = await db.select().from(agentMessages).where(eq(agentMessages.id, messageId));
    expect(msg!.txnIds).toEqual([r.txnId]);
    // Reads see the new state.
    const outline = await executeTool(host, 'get_subtree', { nodeId: rootId });
    expect(JSON.parse(outline.content).nodes[0].style.base.gap).toBe(24);
  });

  it('retries once on a version conflict with a fresh base', async () => {
    const { editor, project, rootId, messageId } = await setup();
    const host = await createDbToolHost(db, editor, {
      projectId: project.id,
      agentMessageId: messageId,
      runtime: 'interactive',
    });
    await host.getDoc(); // cache version 0
    await commitTransaction(db, editor, project.id, {
      baseVersion: 0,
      txn: {
        id: 'user-txn-0001',
        source: 'inspector',
        ops: [{ op: 'setNodeMeta', id: rootId, patch: { name: 'Renamed' } }],
      },
    });
    const r = await executeTool(host, 'patch_nodes', {
      label: 'Gap',
      ops: [{ op: 'setStyle', id: rootId, breakpoint: 'base', prop: 'gap', value: 8 }],
    });
    expect(r.isError).toBe(false);
    expect((await getDoc(db, editor, project.id)).version).toBe(2);
  });

  it('runs the auto-snapshot hook once, before the first commit', async () => {
    const { editor, project, rootId, messageId } = await setup();
    const calls: string[] = [];
    const host = await createDbToolHost(db, editor, {
      projectId: project.id,
      agentMessageId: messageId,
      runtime: 'interactive',
      beforeFirstCommit: async () => void calls.push('snapshot'),
      onCommit: async () => void calls.push('commit'),
    });
    for (const v of [1, 2])
      await executeTool(host, 'patch_nodes', {
        label: 'x',
        ops: [{ op: 'setStyle', id: rootId, breakpoint: 'base', prop: 'gap', value: v }],
      });
    expect(calls).toEqual(['snapshot', 'commit', 'commit']);
  });

  it('refuses viewers', async () => {
    const { actor, project, messageId } = await setup('viewer');
    await expect(
      createDbToolHost(db, actor, {
        projectId: project.id,
        agentMessageId: messageId,
        runtime: 'interactive',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('returns invalid ops to the model as errors without writing', async () => {
    const { editor, project, messageId } = await setup();
    const host = await createDbToolHost(db, editor, {
      projectId: project.id,
      agentMessageId: messageId,
      runtime: 'interactive',
    });
    const r = await executeTool(host, 'patch_nodes', {
      label: 'x',
      ops: [{ op: 'removeNode', id: 'n_doesnotexist' }],
    });
    expect(r.isError).toBe(true);
    expect(await db.select().from(docOps)).toHaveLength(0);
  });
});
