'use client';

/** Agent pane (Epic 5): the project's conversation with the agent. Reads useEditor()/useDocStore(). */
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { useEditor } from '../doc-store';
import type { JobSuggestion } from './api';
import { Composer } from './composer';
import { MessageItem } from './message-item';
import { useAgentChat } from './use-agent-chat';

const KIND_LABEL: Record<JobSuggestion['kind'], string> = {
  generate: 'Generate frames',
  redesign: 'Redesign',
  alternatives: 'Alternatives',
};

function JobSuggestionCard({ s }: { s: JobSuggestion }) {
  return (
    <div className="card mt-2 p-3 text-xs" data-testid="job-suggestion">
      <p className="font-medium">{KIND_LABEL[s.kind]}</p>
      <p className="mt-0.5 text-muted">{s.prompt}</p>
      <p className="mt-2 text-muted">Background jobs run with the generation model.</p>
    </div>
  );
}

export function AgentPane() {
  const { agentAvailable, can, workspace, project } = useEditor();
  const canRun = can('agent:run');
  const chat = useAgentChat(project.id, agentAvailable, canRun && agentAvailable);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [chat.messages]);

  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <p className="font-medium">Agent</p>
        {chat.busy && <span className="text-xs text-muted">Working…</span>}
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4" aria-live="polite">
        {!canRun ? (
          <p className="text-muted">You have view access. Ask an editor to make changes.</p>
        ) : !agentAvailable ? (
          <p className="text-muted">
            No model connected.{' '}
            {can('workspace:manage_credentials') ? (
              <Link className="underline" href={`/w/${workspace.slug}/settings/credentials`}>
                Add a credential
              </Link>
            ) : (
              'Ask a workspace admin to add one.'
            )}
          </p>
        ) : !chat.loading && chat.messages.length === 0 ? (
          <p className="text-muted">
            Describe a change (“make the hero headline larger”), select an element first to focus
            the agent, or ask for a new page.
          </p>
        ) : null}
        {chat.messages.map((m) => (
          <MessageItem
            key={m.id}
            m={m}
            canRun={canRun && agentAvailable}
            onCancel={() => void chat.cancel(m.id)}
            onRetry={() => void chat.retry(m.id)}
            extra={m.jobSuggestion ? <JobSuggestionCard s={m.jobSuggestion} /> : null}
          />
        ))}
        {chat.error && (
          <p className="text-xs text-danger" role="alert">
            {chat.error}{' '}
            <button type="button" className="underline" onClick={chat.dismissError}>
              Dismiss
            </button>
          </p>
        )}
        <div ref={endRef} />
      </div>
      {canRun && agentAvailable && (
        <Composer
          projectId={project.id}
          disabled={chat.busy}
          onSend={(prompt, attachments) => chat.send(prompt, { attachments })}
        />
      )}
    </div>
  );
}
