import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@crunch/authz';
import { applyOps, replaceDocOps } from '@crunch/doc-model';
import { agentMessages, docVersions, eq } from '@crunch/db';
import { runAssistantMessage, sendMessage } from '@/server/services/agent';
import { getRevertTarget } from '@/server/services/agent/snapshots';
import { commitTransaction, getDoc } from '@/server/services/design-docs';
import { createProject } from '@/server/services/projects';
import { ValidationError } from '@/server/services/types';
import type { LlmProxyDeps } from '@/server/services/llm-proxy';
import { makeActor, reset, testDb } from './helpers';
import { scriptedClient, textBlock, toolUse } from './fakes/anthropic';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

const gap = (id: string, root: string, v: number) =>
  toolUse(id, 'patch_nodes', {
    label: 'gap',
    ops: [{ op: 'setStyle', id: root, breakpoint: 'base', prop: 'gap', value: v }],
  });

async function setup() {
  const editor = await makeActor(db, 'editor');
  const project = await createProject(db, editor, { name: 'P' });
  const before = await getDoc(db, editor, project.id);
  return { editor, project, before, root: before.doc.frames[0]!.rootNodeId };
}

const proxyFor = (script: Parameters<typeof scriptedClient>[0]): LlmProxyDeps => {
  const c = scriptedClient(script);
  return { loadClient: async () => ({ messages: c.messages, provider: 'anthropic' }) };
};

describe('auto snapshots before agent edits', () => {
  it('snapshots once per message, before the first transaction, and links it', async () => {
    const { editor, project, before, root } = await setup();
    const sent = await sendMessage(db, editor, { projectId: project.id, prompt: 'spacing' });
    const view = await runAssistantMessage(db, editor, sent.messageId, {
      proxy: proxyFor([
        { content: [gap('t1', root, 8)], stopReason: 'tool_use' },
        { content: [gap('t2', root, 16)], stopReason: 'tool_use' },
        { content: [textBlock('Done')] },
      ]),
    });
    expect(view.txnIds).toHaveLength(2);
    expect(view.snapshotVersionId).toBeTruthy();
    const snaps = await db.select().from(docVersions).where(eq(docVersions.projectId, project.id));
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      kind: 'auto',
      agentMessageId: sent.messageId,
      docVersion: before.version,
    });
    expect(snaps[0]!.doc).toEqual(before.doc);
  });

  it('reverts in one click, and the revert is itself undoable', async () => {
    const { editor, project, before, root } = await setup();
    const sent = await sendMessage(db, editor, { projectId: project.id, prompt: 'spacing' });
    await runAssistantMessage(db, editor, sent.messageId, {
      proxy: proxyFor([
        { content: [gap('t1', root, 40)], stopReason: 'tool_use' },
        { content: [textBlock('Done')] },
      ]),
    });
    const after = await getDoc(db, editor, project.id);
    expect(after.doc.nodes[root]!.style.base?.gap).toBe(40);

    const { doc: target } = await getRevertTarget(db, editor, sent.messageId);
    expect(target).toEqual(before.doc);
    // What the editor does: one 'restore' transaction through the normal path.
    const ops = replaceDocOps(after.doc, target);
    const { inverse } = applyOps(after.doc, ops);
    await commitTransaction(db, editor, project.id, {
      baseVersion: after.version,
      txn: { id: 'revert-0000001', source: 'restore', label: 'Revert agent change', ops },
    });
    const reverted = await getDoc(db, editor, project.id);
    expect(reverted.doc.nodes[root]!.style.base?.gap).toEqual(
      before.doc.nodes[root]!.style.base?.gap,
    );
    // Undo the revert with its inverse.
    await commitTransaction(db, editor, project.id, {
      baseVersion: reverted.version,
      txn: { id: 'undo-revert-01', source: 'restore', ops: inverse },
    });
    expect((await getDoc(db, editor, project.id)).doc.nodes[root]!.style.base?.gap).toBe(40);
  });

  it('only editors can revert, and only messages that changed something', async () => {
    const { editor, project } = await setup();
    const sent = await sendMessage(db, editor, { projectId: project.id, prompt: 'hi' });
    await runAssistantMessage(db, editor, sent.messageId, {
      proxy: proxyFor([{ content: [textBlock('Hi!')] }]),
    });
    const [msg] = await db.select().from(agentMessages).where(eq(agentMessages.id, sent.messageId));
    expect(msg!.snapshotVersionId).toBeNull();
    await expect(getRevertTarget(db, editor, sent.messageId)).rejects.toBeInstanceOf(
      ValidationError,
    );
    const viewer = await makeActor(db, 'viewer', editor.workspace);
    await expect(getRevertTarget(db, viewer, sent.messageId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
