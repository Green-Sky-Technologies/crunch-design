/**
 * Consumer side of the requestAgentEdit contract (Story 5.7). The agent stream implements
 * POST AGENT_EDIT_ENDPOINT; until it merges the endpoint 404s and we report "unavailable".
 */
import {
  AGENT_EDIT_ENDPOINT,
  agentEditRequest,
  agentEditResponse,
  type AgentEditRequest,
  type AgentEditResponse,
} from '@crunch/contracts';
import { commentsApi, type Thread } from './api';
import type { AgentState } from './store';

export type AgentEditResult =
  | { ok: true; data: AgentEditResponse }
  | { ok: false; unavailable: true }
  | { ok: false; unavailable: false; message: string };

export async function requestAgentEdit(
  input: AgentEditRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentEditResult> {
  const body = agentEditRequest.parse(input);
  let res: Response;
  try {
    res = await fetchImpl(AGENT_EDIT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, unavailable: false, message: 'Network error; try again.' };
  }
  // Not implemented yet (404), or deliberately disabled (501).
  if (res.status === 404 || res.status === 501) return { ok: false, unavailable: true };
  if (!res.ok) {
    let message = `The agent couldn't take this request (${res.status}).`;
    try {
      const b = (await res.json()) as { message?: string };
      if (b.message) message = b.message;
    } catch {
      // non-JSON body
    }
    return { ok: false, unavailable: false, message };
  }
  const parsed = agentEditResponse.safeParse(await res.json().catch(() => null));
  if (!parsed.success)
    return { ok: false, unavailable: false, message: 'Unexpected response from the agent.' };
  return { ok: true, data: parsed.data };
}

/** Send an ask-agent thread to the agent and link the conversation. Returns the new state. */
export async function sendThreadToAgent(
  t: Thread,
  opts: { allowWiderScope: boolean },
  fetchImpl?: typeof fetch,
): Promise<{ state: AgentState; thread?: Thread }> {
  if (t.anchor.type !== 'node')
    return { state: { status: 'error', message: 'Pin the request to an element first.' } };
  const prompt = t.comments[0]?.body ?? '';
  const r = await requestAgentEdit(
    {
      projectId: t.projectId,
      frameId: t.anchor.frameId,
      nodeId: t.anchor.nodeId,
      prompt,
      commentThreadId: t.id,
      allowWiderScope: opts.allowWiderScope,
    },
    fetchImpl,
  );
  if (!r.ok)
    return {
      state: r.unavailable ? { status: 'unavailable' } : { status: 'error', message: r.message },
    };
  let thread: Thread | undefined;
  try {
    thread = (await commentsApi.linkConversation(t.id, r.data.conversationId)).thread;
  } catch {
    // The agent service may link it itself; the request was still accepted.
  }
  return {
    state: { status: 'sent', conversationId: r.data.conversationId, streamUrl: r.data.streamUrl },
    thread,
  };
}
