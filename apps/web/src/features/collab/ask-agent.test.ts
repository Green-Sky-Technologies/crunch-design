import { AGENT_EDIT_ENDPOINT } from '@crunch/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Thread } from './api';
import { requestAgentEdit, sendThreadToAgent } from './ask-agent';

const projectId = '3f2b8f0e-8a39-4b8e-9a51-0d6f4c1c2e11';
const threadId = '9d7a3a43-5d55-4b0e-8f2a-3b0b6d8d1e22';
const conversationId = '0b8c2f9e-1d4b-4d1f-b6c9-3c3e1f0d2a33';
const messageId = '5e0b1c2d-3f4a-4b5c-8d6e-7f8091a2b344';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: threadId,
  projectId,
  kind: 'agent_request',
  status: 'open',
  anchor: { type: 'node', frameId: 'f_frame0001', nodeId: 'n_node000001' },
  fallback: null,
  orphaned: false,
  agentConversationId: null,
  createdBy: 'u',
  createdAt: new Date().toISOString(),
  resolvedBy: null,
  resolvedAt: null,
  comments: [
    {
      id: 'c',
      authorType: 'user',
      authorId: 'u',
      authorName: null,
      body: 'Make the button larger',
      mentions: [],
      createdAt: new Date().toISOString(),
    },
  ],
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe('requestAgentEdit (contract consumer)', () => {
  const req = {
    projectId,
    frameId: 'f_frame0001',
    nodeId: 'n_node000001',
    prompt: 'Bigger',
    allowWiderScope: false,
  };

  it('reports "unavailable" while the agent endpoint is not implemented (404)', async () => {
    const f = vi.fn(async () => json(404, { error: 'not_found' }));
    expect(await requestAgentEdit(req, f)).toEqual({ ok: false, unavailable: true });
    expect(f).toHaveBeenCalledWith(
      AGENT_EDIT_ENDPOINT,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns the validated response on success', async () => {
    const data = { conversationId, messageId, streamUrl: '/api/agent/stream/x' };
    const r = await requestAgentEdit(req, async () => json(200, data));
    expect(r).toEqual({ ok: true, data });
  });

  it('surfaces server errors and malformed responses', async () => {
    expect(
      await requestAgentEdit(req, async () => json(403, { message: 'No permission' })),
    ).toEqual({ ok: false, unavailable: false, message: 'No permission' });
    const bad = await requestAgentEdit(req, async () => json(200, { nope: true }));
    expect(bad.ok).toBe(false);
    const offline = await requestAgentEdit(req, async () => {
      throw new TypeError('fetch failed');
    });
    expect(offline).toMatchObject({ ok: false, unavailable: false });
  });

  it('validates the request against the contract before sending', async () => {
    const f = vi.fn();
    await expect(requestAgentEdit({ ...req, prompt: '' }, f)).rejects.toThrow();
    expect(f).not.toHaveBeenCalled();
  });
});

describe('sendThreadToAgent', () => {
  it('sends the thread node, prompt and scope approval, then links the conversation', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      if (String(url) === AGENT_EDIT_ENDPOINT)
        return json(200, { conversationId, messageId, streamUrl: '/s' });
      return json(200, { thread: thread({ agentConversationId: conversationId }) });
    });
    vi.stubGlobal('fetch', f);
    const r = await sendThreadToAgent(thread(), { allowWiderScope: true });
    expect(r.state).toEqual({ status: 'sent', conversationId, streamUrl: '/s' });
    expect(r.thread?.agentConversationId).toBe(conversationId);
    expect(calls[0]).toEqual({
      url: AGENT_EDIT_ENDPOINT,
      body: {
        projectId,
        frameId: 'f_frame0001',
        nodeId: 'n_node000001',
        prompt: 'Make the button larger',
        commentThreadId: threadId,
        allowWiderScope: true,
      },
    });
    expect(calls[1]).toEqual({
      url: `/api/comments/${threadId}`,
      body: { agentConversationId: conversationId },
    });
  });

  it('does not link anything when the agent is unavailable', async () => {
    const f = vi.fn(async () => json(404, {}));
    vi.stubGlobal('fetch', f);
    expect((await sendThreadToAgent(thread(), { allowWiderScope: false })).state).toEqual({
      status: 'unavailable',
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('refuses canvas-anchored threads', async () => {
    const r = await sendThreadToAgent(thread({ anchor: { type: 'canvas', x: 0, y: 0 } }), {
      allowWiderScope: false,
    });
    expect(r.state.status).toBe('error');
  });
});
