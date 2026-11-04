import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@crunch/authz';
import { agentEditResponse } from '@crunch/contracts';
import { agentConversations, eq } from '@crunch/db';
import type { Node } from '@crunch/doc-model';
import { runAssistantMessage } from '@/server/services/agent';
import { requestAgentEdit } from '@/server/services/agent/edit';
import { commitTransaction, getDoc } from '@/server/services/design-docs';
import { createProject } from '@/server/services/projects';
import { NotFoundError, ValidationError } from '@/server/services/types';
import type { LlmProxyDeps } from '@/server/services/llm-proxy';
import { makeActor, reset, testDb } from './helpers';
import { scriptedClient, textBlock, toolUse } from './fakes/anthropic';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

const text = (id: string, parentId: string, t: string): Node => ({
  id,
  type: 'text',
  tag: 'p',
  parentId,
  children: [],
  positioning: 'flow',
  style: {},
  props: { text: t },
});

/** A page with a "button" section and an unrelated footer. */
async function setup() {
  const editor = await makeActor(db, 'editor');
  const project = await createProject(db, editor, { name: 'P' });
  const { doc } = await getDoc(db, editor, project.id);
  const frame = doc.frames[0]!;
  const root = frame.rootNodeId;
  await commitTransaction(db, editor, project.id, {
    baseVersion: 0,
    txn: {
      id: 'seed-txn-0001',
      source: 'canvas',
      ops: [
        {
          op: 'insertSubtree',
          parentId: root,
          index: 0,
          nodes: [
            {
              id: 'n_buttonbox1',
              type: 'box',
              tag: 'div',
              parentId: root,
              children: ['n_buttonlbl1'],
              positioning: 'flow',
              style: {},
              props: {},
            },
            text('n_buttonlbl1', 'n_buttonbox1', 'Buy now'),
          ],
        },
        {
          op: 'insertSubtree',
          parentId: root,
          index: 1,
          nodes: [text('n_footertxt1', root, 'Secret footer copy')],
        },
      ],
    },
  });
  return { editor, project, frameId: frame.id };
}

const proxy = (script: Parameters<typeof scriptedClient>[0]) => {
  const client = scriptedClient(script);
  const deps: LlmProxyDeps = {
    loadClient: async () => ({ messages: client.messages, provider: 'anthropic' }),
  };
  return { client, deps };
};

const padButton = (id: string) =>
  toolUse('tu_1', 'patch_nodes', {
    label: 'Larger',
    ops: [{ op: 'setStyle', id, breakpoint: 'base', prop: 'paddingTop', value: 16 }],
  });

describe('requestAgentEdit (POST /api/agent/edit)', () => {
  it('returns the contract response and sends only the node subtree', async () => {
    const { editor, project, frameId } = await setup();
    const res = await requestAgentEdit(db, editor, {
      projectId: project.id,
      frameId,
      nodeId: 'n_buttonbox1',
      prompt: 'make this button larger',
    });
    expect(
      agentEditResponse.safeParse({
        conversationId: res.conversationId,
        messageId: res.messageId,
        streamUrl: res.streamUrl,
      }).success,
    ).toBe(true);
    expect(res.streamUrl).toBe(`/api/agent/messages/${res.messageId}/stream`);

    const { client, deps } = proxy([
      { content: [padButton('n_buttonbox1')], stopReason: 'tool_use' },
      { content: [textBlock('Done')] },
    ]);
    const view = await runAssistantMessage(db, editor, res.messageId, { proxy: deps });
    expect(view).toMatchObject({ status: 'complete', touched: ['n_buttonbox1'] });
    const sent = JSON.stringify(client.calls[0]!.messages);
    expect(sent).toContain('Buy now');
    expect(sent).not.toContain('Secret footer copy');
    expect(sent).not.toContain('<outline>');
  });

  it('rejects patches outside the subtree unless a wider change was approved', async () => {
    const { editor, project, frameId } = await setup();
    const scoped = await requestAgentEdit(db, editor, {
      projectId: project.id,
      frameId,
      nodeId: 'n_buttonbox1',
      prompt: 'x',
    });
    const a = proxy([
      { content: [padButton('n_footertxt1')], stopReason: 'tool_use' },
      { content: [textBlock('Could not')] },
    ]);
    await runAssistantMessage(db, editor, scoped.messageId, { proxy: a.deps });
    const toolResult = JSON.stringify(a.client.calls[1]!.messages.at(-1));
    expect(toolResult).toContain('Out of scope');
    expect(
      (await getDoc(db, editor, project.id)).doc.nodes['n_footertxt1']!.style.base,
    ).toBeUndefined();

    const wide = await requestAgentEdit(db, editor, {
      projectId: project.id,
      frameId,
      nodeId: 'n_buttonbox1',
      prompt: 'also the footer',
      allowWiderScope: true,
    });
    const b = proxy([
      { content: [padButton('n_footertxt1')], stopReason: 'tool_use' },
      { content: [textBlock('Done')] },
    ]);
    await runAssistantMessage(db, editor, wide.messageId, { proxy: b.deps });
    expect(
      (await getDoc(db, editor, project.id)).doc.nodes['n_footertxt1']!.style.base?.paddingTop,
    ).toBe(16);
  });

  it('continues the conversation for the same comment thread', async () => {
    const { editor, project, frameId } = await setup();
    const threadId = crypto.randomUUID();
    const first = await requestAgentEdit(db, editor, {
      projectId: project.id,
      frameId,
      nodeId: 'n_buttonbox1',
      prompt: 'a',
      commentThreadId: threadId,
    });
    const second = await requestAgentEdit(db, editor, {
      projectId: project.id,
      frameId,
      nodeId: 'n_buttonbox1',
      prompt: 'b',
      commentThreadId: threadId,
    });
    expect(second.conversationId).toBe(first.conversationId);
    const [conv] = await db
      .select()
      .from(agentConversations)
      .where(eq(agentConversations.id, first.conversationId));
    expect(conv).toMatchObject({
      commentThreadId: threadId,
      scope: { nodeId: 'n_buttonbox1', frameId },
    });
  });

  it('validates the request, the node and permissions', async () => {
    const { editor, project, frameId } = await setup();
    const viewer = await makeActor(db, 'viewer', editor.workspace);
    const base = { projectId: project.id, frameId, nodeId: 'n_buttonbox1', prompt: 'x' };
    await expect(requestAgentEdit(db, viewer, base)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      requestAgentEdit(db, editor, { ...base, nodeId: 'n_missing0001' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      requestAgentEdit(db, editor, { ...base, frameId: 'f_other00001' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(requestAgentEdit(db, editor, { ...base, extra: 1 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    const other = await makeActor(db, 'editor');
    await expect(requestAgentEdit(db, other, base)).rejects.toBeInstanceOf(NotFoundError);
  });
});
