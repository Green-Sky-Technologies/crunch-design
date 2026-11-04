'use client';

/**
 * Ask-agent comments (Story 5.7, UI). An element-pinned comment can be sent to the agent as a
 * scoped edit request. The request carries only the node (the agent loads its subtree and the
 * design system); edits outside the subtree need the explicit "allow wider changes" approval.
 */
import { useState } from 'react';
import { useEditor } from '../doc-store';
import type { Anchor, Thread } from './api';
import { sendThreadToAgent } from './ask-agent';
import type { ComposerExtras, ThreadExtras } from './comments-panel';
import { useCollab } from './store';

function AgentStatus({ t }: { t: Thread }) {
  const { can } = useEditor();
  const state = useCollab((s) => s.agent[t.id]);
  const setAgentState = useCollab((s) => s.setAgentState);
  const upsert = useCollab((s) => s.upsertThread);
  if (t.kind !== 'agent_request') return null;

  const retry = async () => {
    setAgentState(t.id, { status: 'sending' });
    const r = await sendThreadToAgent(t, { allowWiderScope: false });
    setAgentState(t.id, r.state);
    if (r.thread) upsert(r.thread);
  };
  const canRetry = can('agent:run') && t.status === 'open' && !t.orphaned;

  let body: React.ReactNode;
  if (state?.status === 'sending') body = 'Sending to the agent…';
  else if (state?.status === 'sent' || (!state && t.agentConversationId))
    body = 'Sent to the agent. Follow its progress in the chat panel.';
  else if (state?.status === 'unavailable')
    body = (
      <>
        Agent edits from comments aren&apos;t available yet. The request is saved as a comment.
        {canRetry && (
          <button className="ml-2 underline" onClick={() => void retry()}>
            Try again
          </button>
        )}
      </>
    );
  else if (state?.status === 'error')
    body = (
      <>
        {state.message}
        {canRetry && (
          <button className="ml-2 underline" onClick={() => void retry()}>
            Retry
          </button>
        )}
      </>
    );
  else if (canRetry)
    body = (
      <button className="underline" onClick={() => void retry()}>
        Send to the agent
      </button>
    );
  else return null;

  return (
    <p
      className={`mt-2 rounded bg-surface-2 px-2 py-1 text-xs ${state?.status === 'error' ? 'text-danger' : 'text-muted'}`}
      role="status"
      data-agent-status={state?.status ?? (t.agentConversationId ? 'sent' : 'idle')}
    >
      {body}
    </p>
  );
}

export function useAskAgentExtras(): { composer?: ComposerExtras; thread: ThreadExtras } {
  const { can, agentAvailable } = useEditor();
  const [ask, setAsk] = useState(false);
  const [wider, setWider] = useState(false);
  const setAgentState = useCollab((s) => s.setAgentState);
  const upsert = useCollab((s) => s.upsertThread);
  const thread: ThreadExtras = { renderThreadExtra: (t) => <AgentStatus t={t} /> };
  if (!can('agent:run')) return { thread };

  const composer: ComposerExtras = {
    kind: ask ? 'agent_request' : 'discussion',
    renderExtra: (anchor: Anchor) =>
      anchor.type !== 'node' ? null : (
        <div className="flex flex-col gap-1 text-xs text-muted">
          <label
            className="flex items-center gap-1.5"
            title={agentAvailable ? undefined : 'Add a model credential in workspace settings'}
          >
            <input
              type="checkbox"
              checked={ask}
              disabled={!agentAvailable}
              onChange={(e) => setAsk(e.target.checked)}
            />
            Ask agent to change this element
          </label>
          {ask && (
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={wider} onChange={(e) => setWider(e.target.checked)} />
              Allow changes outside it
            </label>
          )}
        </div>
      ),
    afterCreate: (t) => {
      setAgentState(t.id, { status: 'sending' });
      void sendThreadToAgent(t, { allowWiderScope: wider }).then((r) => {
        setAgentState(t.id, r.state);
        if (r.thread) upsert(r.thread);
      });
      setAsk(false);
      setWider(false);
    },
  };
  return { composer, thread };
}
