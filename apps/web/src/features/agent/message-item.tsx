'use client';

import type { ReactNode } from 'react';
import type { MessageView, ToolActivity } from './api';

const TOOL_LABELS: Record<string, string> = {
  get_outline: 'Reading the outline',
  get_subtree: 'Reading elements',
  patch_nodes: 'Editing',
  insert_frame: 'Adding a frame',
  create_slider: 'Adding a slider',
  get_design_system: 'Checking the design system',
  run_lint: 'Checking against the design system',
  suggest_generation_job: 'Suggesting a background job',
  screenshot_frame: 'Taking a screenshot',
  capture_url: 'Capturing a page',
  get_figma_frame: 'Fetching from Figma',
};

function ActivityChip({ a }: { a: ToolActivity }) {
  const icon = a.status === 'running' ? '…' : a.status === 'done' ? '✓' : '!';
  return (
    <li
      className={`flex items-center gap-1.5 text-xs ${a.status === 'error' ? 'text-danger' : 'text-muted'}`}
      data-status={a.status}
    >
      <span aria-hidden className={a.status === 'running' ? 'animate-pulse' : ''}>
        {icon}
      </span>
      {TOOL_LABELS[a.name] ?? a.name}
    </li>
  );
}

export function MessageItem({
  m,
  canRun,
  onCancel,
  onRetry,
  extra,
}: {
  m: MessageView;
  canRun: boolean;
  onCancel: () => void;
  onRetry: () => void;
  /** Job card, revert button, etc. */
  extra?: ReactNode;
}) {
  if (m.role === 'user')
    return (
      <div className="ml-6 rounded-lg bg-surface-2 px-3 py-2 text-sm whitespace-pre-wrap">
        {m.text}
        {m.attachments.length > 0 && (
          <ul className="mt-1 text-xs text-muted">
            {m.attachments.map((a, i) => (
              <li key={i} className="truncate">
                {a.type === 'figma' ? `Figma ${a.fileKey} · ${a.nodeId}` : a.url}
              </li>
            ))}
          </ul>
        )}
      </div>
    );

  const running = m.status === 'pending' || m.status === 'streaming';
  return (
    <div className="text-sm" aria-busy={running} data-testid="assistant-message">
      {m.text ? (
        <p className="whitespace-pre-wrap">{m.text}</p>
      ) : running && !m.jobId ? (
        <p className="animate-pulse text-muted">Thinking…</p>
      ) : null}
      {m.activity.length > 0 && (
        <ul className="mt-1 space-y-0.5" aria-label="Agent activity">
          {m.activity.map((a) => (
            <ActivityChip key={a.id} a={a} />
          ))}
        </ul>
      )}
      {m.status === 'error' && <p className="mt-1 text-xs text-danger">{m.error ?? 'Failed.'}</p>}
      {m.status === 'cancelled' && <p className="mt-1 text-xs text-muted">Cancelled.</p>}
      {m.status === 'complete' && m.error && <p className="mt-1 text-xs text-muted">{m.error}</p>}
      {extra}
      {canRun && (
        <div className="mt-1 flex gap-2">
          {running && !m.jobId && (
            <button type="button" className="text-xs text-muted underline" onClick={onCancel}>
              Cancel
            </button>
          )}
          {(m.status === 'error' || m.status === 'cancelled') && (
            <button type="button" className="text-xs text-muted underline" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}
