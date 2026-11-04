'use client';

/** Agent pane (Epic 5): the project's conversation with the agent. Reads useEditor()/useDocStore(). */
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../doc-store';
import { agentApi, type JobSuggestion } from './api';
import { Composer } from './composer';
import { JobCard, JobSuggestionCard } from './job-card';
import { MessageItem } from './message-item';
import { ModelPicker, useAgentSettings } from './model-picker';
import { RevertButton } from './revert-button';
import { SliderTray } from './slider-tray';
import { useAgentChat } from './use-agent-chat';

export function AgentPane() {
  const { agentAvailable, can, workspace, project } = useEditor();
  const canRun = can('agent:run');
  const chat = useAgentChat(project.id, agentAvailable, canRun && agentAvailable);
  const endRef = useRef<HTMLDivElement>(null);
  const live = canRun && agentAvailable;
  const settings = useAgentSettings(live);
  const [model, setModel] = useState('');

  const startJob = async (s: JobSuggestion) => {
    try {
      const { message } = await agentApi.startJob({
        projectId: project.id,
        conversationId: chat.conversationId ?? undefined,
        kind: s.kind,
        prompt: s.prompt,
        frameIds: s.frameIds,
        count: s.count,
        model: model || undefined,
      });
      chat.track(message);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Could not start the job');
    }
  };

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
        {project.archived ? (
          <p className="text-muted">This project is archived. Restore it to make changes.</p>
        ) : !canRun ? (
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
            extra={
              <>
                {m.jobSuggestion && (
                  <JobSuggestionCard s={m.jobSuggestion} canRun={live} onStart={startJob} />
                )}
                {m.jobId && <JobCard jobId={m.jobId} canRun={live} />}
                {m.snapshotVersionId &&
                  m.txnIds.length > 0 &&
                  can('design:edit') &&
                  !['pending', 'streaming'].includes(m.status) && (
                    <div className="mt-1">
                      <RevertButton messageId={m.id} />
                    </div>
                  )}
              </>
            }
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
      <SliderTray />
      {canRun && agentAvailable && (
        <Composer
          projectId={project.id}
          disabled={chat.busy}
          onSend={(prompt, attachments) =>
            chat.send(prompt, { attachments, model: model || undefined })
          }
          modelPicker={<ModelPicker settings={settings} value={model} onChange={setModel} />}
        />
      )}
    </div>
  );
}
