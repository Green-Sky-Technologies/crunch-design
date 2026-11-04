import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@crunch/authz';
import { Anthropic, parseSse } from '@crunch/agent';
import { agentMessages, eq, llmCalls, workspaceAgentSettings } from '@crunch/db';
import {
  cancelMessage,
  getProjectChat,
  messageEvents,
  runAssistantMessage,
  sendMessage,
} from '@/server/services/agent';
import { getDoc } from '@/server/services/design-docs';
import { createProject } from '@/server/services/projects';
import type { LlmProxyDeps, MessagesApi } from '@/server/services/llm-proxy';
import { ValidationError } from '@/server/services/types';
import { makeActor, reset, testDb } from './helpers';
import { scriptedClient, textBlock, toolUse, type ScriptedResponse } from './fakes/anthropic';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

async function setup() {
  const editor = await makeActor(db, 'editor');
  const project = await createProject(db, editor, { name: 'P' });
  const { doc } = await getDoc(db, editor, project.id);
  return { editor, project, rootId: doc.frames[0]!.rootNodeId };
}

const proxyWith = (client: { messages: MessagesApi }): LlmProxyDeps => ({
  loadClient: async () => ({ messages: client.messages, provider: 'anthropic' }),
});

const patchRoot = (rootId: string, value: number): ScriptedResponse => ({
  content: [
    textBlock('On it.'),
    toolUse('tu_1', 'patch_nodes', {
      label: 'Gap',
      ops: [{ op: 'setStyle', id: rootId, breakpoint: 'base', prop: 'gap', value }],
    }),
  ],
  stopReason: 'tool_use',
});

describe('interactive agent', () => {
  it('runs a turn: streams, patches the doc, meters the call and persists the reply', async () => {
    const { editor, project, rootId } = await setup();
    const client = scriptedClient([
      patchRoot(rootId, 32),
      { content: [textBlock('Gap set to 32.')] },
    ]);
    const sent = await sendMessage(db, editor, {
      projectId: project.id,
      prompt: 'more space between sections',
      selection: [rootId],
    });
    expect(sent.needsRun).toBe(true);
    const view = await runAssistantMessage(db, editor, sent.messageId, {
      proxy: proxyWith(client),
    });
    expect(view).toMatchObject({
      status: 'complete',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
    });
    expect(view.text).toContain('Gap set to 32.');
    expect(view.touched).toEqual([rootId]);
    expect(view.txnIds).toHaveLength(1);
    expect((await getDoc(db, editor, project.id)).doc.nodes[rootId]!.style.base?.gap).toBe(32);

    // The request carried the cached prefix, the doc context and the prompt.
    const req = client.calls[0]!;
    expect(req.system).toBeDefined();
    expect(JSON.stringify(req.messages)).toContain('<document>');
    expect(JSON.stringify(req.messages)).toContain('more space between sections');
    expect(req.cache_control).toEqual({ type: 'ephemeral' });

    const calls = await db.select().from(llmCalls);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.task === 'interactive' && c.messageId === sent.messageId)).toBe(
      true,
    );

    const chat = await getProjectChat(db, editor, project.id);
    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(chat.messages[0]!.text).toBe('more space between sections');
  });

  it('sends earlier turns as history on the next message', async () => {
    const { editor, project, rootId } = await setup();
    const client = scriptedClient([
      patchRoot(rootId, 8),
      { content: [textBlock('Done.')] },
      { content: [textBlock('Sure.')] },
    ]);
    const first = await sendMessage(db, editor, { projectId: project.id, prompt: 'tighten' });
    await runAssistantMessage(db, editor, first.messageId, { proxy: proxyWith(client) });
    const second = await sendMessage(db, editor, {
      projectId: project.id,
      conversationId: first.conversationId,
      prompt: 'thanks',
    });
    await runAssistantMessage(db, editor, second.messageId, { proxy: proxyWith(client) });
    const req = client.calls[2]!;
    // user, assistant(tool_use), user(tool_result), assistant(text), user(new)
    expect(req.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
  });

  it('offers a generation job for big requests without calling the model', async () => {
    const { editor, project } = await setup();
    const sent = await sendMessage(db, editor, {
      projectId: project.id,
      prompt: 'Design a pricing page',
    });
    expect(sent.needsRun).toBe(false);
    const chat = await getProjectChat(db, editor, project.id);
    expect(chat.messages[1]).toMatchObject({
      status: 'complete',
      jobSuggestion: { kind: 'generate', prompt: 'Design a pricing page' },
    });
    expect(await db.select().from(llmCalls)).toHaveLength(0);
  });

  it('keeps viewers out and enforces the allowed model list', async () => {
    const { editor, project } = await setup();
    const viewer = await makeActor(db, 'viewer', editor.workspace);
    await expect(
      sendMessage(db, viewer, { projectId: project.id, prompt: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await db
      .insert(workspaceAgentSettings)
      .values({ workspaceId: editor.workspace.id, allowedModels: ['claude-haiku-5-5'] });
    await expect(
      sendMessage(db, editor, { projectId: project.id, prompt: 'x', model: 'claude-opus-5-5' }),
    ).rejects.toBeInstanceOf(ValidationError);
    const sent = await sendMessage(db, editor, { projectId: project.id, prompt: 'x' });
    const [row] = await db.select().from(agentMessages).where(eq(agentMessages.id, sent.messageId));
    expect(row!.model).toBe('claude-haiku-5-5');
  });

  it('cancels a running turn', async () => {
    const { editor, project } = await setup();
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const hanging: MessagesApi = {
      stream: (_body, opts) => ({
        async *[Symbol.asyncIterator]() {
          started();
          await new Promise((_r, reject) =>
            opts?.signal?.addEventListener('abort', () => {
              const e = new Error('aborted');
              e.name = 'AbortError';
              reject(e);
            }),
          );
        },
        finalMessage: () => new Promise(() => {}),
      }),
      countTokens: async () => ({ input_tokens: 0 }) as Anthropic.MessageTokensCount,
    };
    const sent = await sendMessage(db, editor, { projectId: project.id, prompt: 'slow' });
    const run = runAssistantMessage(db, editor, sent.messageId, {
      proxy: proxyWith({ messages: hanging }),
      cancelPollMs: 20,
    });
    await startedP;
    await cancelMessage(db, editor, sent.messageId);
    const view = await run;
    expect(view.status).toBe('cancelled');
    const [call] = await db.select().from(llmCalls);
    expect(call).toMatchObject({ ok: false, errorType: 'aborted' });
  });

  it('records provider failures on the message without leaking details', async () => {
    const { editor, project } = await setup();
    const err = new Anthropic.AuthenticationError(
      401,
      { type: 'error', error: { type: 'authentication_error', message: 'bad key sk-ant-xyz' } },
      'bad key sk-ant-xyz',
      new Headers(),
    );
    const client = scriptedClient([{ content: [], error: err }]);
    const sent = await sendMessage(db, editor, { projectId: project.id, prompt: 'x' });
    const view = await runAssistantMessage(db, editor, sent.messageId, {
      proxy: proxyWith(client),
    });
    expect(view.status).toBe('error');
    expect(view.error).toContain('HTTP 401');
    expect(view.error).not.toContain('sk-ant');
  });

  it('streams message state over SSE until done', async () => {
    const { editor, project } = await setup();
    const client = scriptedClient([{ content: [textBlock('Hello there')] }]);
    const sent = await sendMessage(db, editor, { projectId: project.id, prompt: 'hi' });
    await runAssistantMessage(db, editor, sent.messageId, { proxy: proxyWith(client) });
    let text = '';
    for await (const f of messageEvents(db, editor, sent.messageId, { pollMs: 5 })) text += f;
    const events = parseSse(text);
    expect(events.map((e) => e.event)).toEqual(['open', 'message', 'done']);
    expect(JSON.parse(events[1]!.data)).toMatchObject({ status: 'complete', text: 'Hello there' });
  });
});
