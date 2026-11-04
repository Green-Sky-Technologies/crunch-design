/** Conversation history stays bounded and carries the document only on the newest turn (review #9). */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Anthropic } from '@crunch/agent';
import { agentMessages } from '@crunch/db';
import {
  MAX_HISTORY_CHARS,
  runAssistantMessage,
  sendMessage,
  windowHistory,
} from '@/server/services/agent';
import { createProject } from '@/server/services/projects';
import type { LlmProxyDeps } from '@/server/services/llm-proxy';
import { makeActor, reset, testDb } from './helpers';
import { scriptedClient, textBlock } from './fakes/anthropic';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('document context', () => {
  it('only the newest user message carries a <document> block', async () => {
    const editor = await makeActor(db, 'editor');
    const project = await createProject(db, editor, { name: 'P' });
    const client = scriptedClient([{ content: [textBlock('ok')] }]);
    const proxy: LlmProxyDeps = {
      loadClient: async () => ({ messages: client.messages, provider: 'anthropic' }),
    };
    let conversationId: string | undefined;
    for (const prompt of ['one', 'two', 'three']) {
      const sent = await sendMessage(db, editor, { projectId: project.id, conversationId, prompt });
      conversationId = sent.conversationId;
      await runAssistantMessage(db, editor, sent.messageId, { proxy });
    }
    const last = client.calls.at(-1)!;
    const all = JSON.stringify(last.messages);
    expect(count(all, '<document>')).toBe(1);
    expect(JSON.stringify(last.messages.at(-1))).toContain('<document>');
    expect(all).toContain('one');
    expect(all).toContain('two');
    // Persisted user turns never contain the document.
    const users = (await db.select().from(agentMessages)).filter((m) => m.role === 'user');
    expect(JSON.stringify(users.map((u) => u.content))).not.toContain('<document>');
  });

  it('strips documents from rows stored before this change', async () => {
    const editor = await makeActor(db, 'editor');
    const project = await createProject(db, editor, { name: 'P' });
    const client = scriptedClient([{ content: [textBlock('ok')] }]);
    const proxy: LlmProxyDeps = {
      loadClient: async () => ({ messages: client.messages, provider: 'anthropic' }),
    };
    const first = await sendMessage(db, editor, { projectId: project.id, prompt: 'first' });
    await runAssistantMessage(db, editor, first.messageId, { proxy });
    // Simulate a legacy row: the document inside the stored turn.
    const { eq } = await import('@crunch/db');
    await db
      .update(agentMessages)
      .set({
        content: {
          v: 1,
          prompt: 'first',
          context: {},
          turns: [
            {
              role: 'user',
              content: [
                { type: 'text', text: '<document>\nOLD DOC\n</document>' },
                { type: 'text', text: 'first' },
              ],
            },
          ],
        },
      })
      .where(eq(agentMessages.id, first.userMessageId));
    const second = await sendMessage(db, editor, {
      projectId: project.id,
      conversationId: first.conversationId,
      prompt: 'second',
    });
    await runAssistantMessage(db, editor, second.messageId, { proxy });
    expect(JSON.stringify(client.calls.at(-1)!.messages)).not.toContain('OLD DOC');
  });
});

describe('history window', () => {
  const exchange = (i: number, size: number): Anthropic.MessageParam[] => [
    { role: 'user', content: [{ type: 'text', text: `q${i}` }] },
    { role: 'assistant', content: [{ type: 'text', text: `a${i} ${'x'.repeat(size)}` }] },
  ];

  it('stays within the budget and starts on a user turn', () => {
    const all = Array.from({ length: 40 }, (_, i) => exchange(i, 30_000));
    const h = windowHistory(all);
    expect(JSON.stringify(h).length).toBeLessThanOrEqual(MAX_HISTORY_CHARS);
    expect(h[0]!.role).toBe('user');
    expect(JSON.stringify(h.at(-1))).toContain('a39');
  });

  it('only moves the cut on overflow, so the cached prefix is stable between jumps', () => {
    const all = Array.from({ length: 40 }, (_, i) => exchange(i, 30_000));
    let jumps = 0;
    let prevFirst = '';
    for (let n = 1; n <= all.length; n++) {
      const first = JSON.stringify(windowHistory(all.slice(0, n))[0]);
      if (prevFirst && first !== prevFirst) jumps++;
      prevFirst = first;
    }
    // ~30k per exchange, 200k budget, cut back to 100k on overflow: roughly one jump per 3–4 turns,
    // not one per turn.
    expect(jumps).toBeGreaterThan(0);
    expect(jumps).toBeLessThan(15);
    expect(windowHistory(all.slice(0, 3))).toHaveLength(6); // under budget: untouched
  });
});
