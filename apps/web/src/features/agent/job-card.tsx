'use client';

/** Job cards in the chat (Stories 5.5, 5.6): offer → start → live progress → summary. */
import { useEffect, useState } from 'react';
import { useDocStoreApi } from '../doc-store';
import {
  agentApi,
  followJob,
  type JobEvent,
  type JobStatus,
  type JobSuggestion,
  type MessageView,
} from './api';

const KIND_LABEL: Record<JobSuggestion['kind'], string> = {
  generate: 'Generate frames',
  redesign: 'Redesign',
  alternatives: 'Alternatives',
};

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: 'Queued',
  provisioning: 'Starting a sandbox',
  running: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function JobSuggestionCard({
  s,
  canRun,
  onStart,
}: {
  s: JobSuggestion;
  canRun: boolean;
  onStart: (s: JobSuggestion) => Promise<void>;
}) {
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState(false);
  return (
    <div className="card mt-2 p-3 text-xs" data-testid="job-suggestion">
      <p className="font-medium">
        {KIND_LABEL[s.kind]}
        {s.kind === 'alternatives' && s.count ? ` × ${s.count}` : ''}
      </p>
      <p className="mt-0.5 text-muted">{s.prompt}</p>
      {canRun && !started && (
        <button
          type="button"
          className="btn-primary mt-2 px-2 py-1 text-xs"
          disabled={starting}
          onClick={async () => {
            setStarting(true);
            try {
              await onStart(s);
              setStarted(true);
            } finally {
              setStarting(false);
            }
          }}
        >
          {starting ? 'Starting…' : 'Start background job'}
        </button>
      )}
    </div>
  );
}

export function JobCard({
  jobId,
  canRun,
}: {
  jobId: string;
  canRun: boolean;
  message?: MessageView;
}) {
  const store = useDocStoreApi();
  const [status, setStatus] = useState<JobStatus>('queued');
  const [frames, setFrames] = useState<string[]>([]);
  const [last, setLast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onEvent = (e: JobEvent) => {
      if (e.type === 'status') setStatus(e.data.status as JobStatus);
      else if (e.type === 'frame') {
        setFrames((f) => [...f, String(e.data.name ?? e.data.frameId)]);
        // Frames appear on the canvas as they're built.
        void store
          .getState()
          .pull()
          .catch(() => {});
      } else if (e.type === 'log') setLast(String(e.data.text ?? '').slice(0, 160));
      else if (e.type === 'tool') setLast(`Using ${String(e.data.name)}`);
      else if (e.type === 'error') setError(String(e.data.message ?? 'Job failed'));
      else if (e.type === 'result')
        void store
          .getState()
          .pull()
          .catch(() => {});
    };
    return followJob(jobId, onEvent);
  }, [jobId, store]);

  const active = status === 'queued' || status === 'provisioning' || status === 'running';
  return (
    <div className="card mt-2 p-3 text-xs" data-testid="job-card" data-status={status}>
      <div className="flex items-center justify-between">
        <p className="font-medium">
          Background job ·{' '}
          <span className={status === 'failed' ? 'text-danger' : ''}>{STATUS_LABEL[status]}</span>
        </p>
        {active && canRun && (
          <button
            type="button"
            className="text-muted underline"
            onClick={() => void agentApi.cancelJob(jobId).then((j) => setStatus(j.status))}
          >
            Cancel job
          </button>
        )}
      </div>
      {active && last && <p className="mt-1 truncate text-muted">{last}</p>}
      {frames.length > 0 && (
        <ul className="mt-1 list-disc pl-4">
          {frames.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
      {error && <p className="mt-1 text-danger">{error}</p>}
    </div>
  );
}
