'use client';

/** STUB slot: stream-agent (Epic 5) replaces AgentPane. Reads useEditor()/useDocStore(); no props. */
import Link from 'next/link';
import { useEditor } from '../doc-store';

export function AgentPane() {
  const { agentAvailable, can, workspace } = useEditor();
  return (
    <div className="flex h-full flex-col p-4 text-sm">
      <p className="font-medium">Agent</p>
      {!can('agent:run') ? (
        <p className="mt-2 text-muted">You have view access. Ask an editor to make changes.</p>
      ) : !agentAvailable ? (
        <p className="mt-2 text-muted">
          No model connected.{' '}
          {can('workspace:manage_credentials') ? (
            <Link className="underline" href={`/w/${workspace.slug}/settings/credentials`}>
              Add a credential
            </Link>
          ) : (
            'Ask a workspace admin to add one.'
          )}
        </p>
      ) : (
        <p className="mt-2 text-muted">The conversation will appear here (Epic 5).</p>
      )}
    </div>
  );
}
