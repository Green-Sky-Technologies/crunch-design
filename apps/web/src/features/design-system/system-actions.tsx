'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  archiveDesignSystemAction,
  createDesignSystemAction,
  setDefaultDesignSystemAction,
} from '@/server/actions/design-systems';
import type { SystemOption } from './switch-panel';

/** Story 4.3: create another system (from the starter, blank, or a copy of an existing one). */
export function NewDesignSystemForm({
  workspaceSlug,
  systems,
}: {
  workspaceSlug: string;
  systems: SystemOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [source, setSource] = useState('starter');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!open)
    return (
      <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
        New design system
      </button>
    );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const res = await createDesignSystemAction({
        name,
        source:
          source === 'starter' || source === 'blank'
            ? { kind: source }
            : { kind: 'copy', designSystemId: source },
      });
      if (!res.ok) return setError(res.error);
      router.push(`/w/${workspaceSlug}/design-systems/${res.data.id}`);
    });
  };

  return (
    <form onSubmit={submit} className="card flex flex-wrap items-end gap-2 p-3">
      <label className="text-xs">
        <span className="mb-1 block text-muted">Name</span>
        <input
          className="input w-56"
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </label>
      <label className="text-xs">
        <span className="mb-1 block text-muted">Start from</span>
        <select className="input w-56" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="starter">Starter tokens and components</option>
          <option value="blank">Blank</option>
          {systems.map((s) => (
            <option key={s.id} value={s.id}>
              Copy of {s.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="btn-primary" disabled={pending}>
        {pending ? 'Creating…' : 'Create'}
      </button>
      <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error && <p className="w-full text-xs text-danger">{error}</p>}
    </form>
  );
}

export function SystemCardActions({
  id,
  isDefault,
  projectCount,
}: {
  id: string;
  isDefault: boolean;
  projectCount: number;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const res = await fn();
      setError(res.ok ? null : (res.error ?? 'Failed'));
    });
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
      {!isDefault && (
        <button
          type="button"
          className="btn-ghost py-1 text-xs"
          disabled={pending}
          onClick={() => act(() => setDefaultDesignSystemAction(id))}
        >
          Make default
        </button>
      )}
      {!isDefault && (
        <button
          type="button"
          className="btn-ghost py-1 text-xs"
          disabled={pending || projectCount > 0}
          title={projectCount > 0 ? 'Switch its projects to another system first' : undefined}
          onClick={() => act(() => archiveDesignSystemAction(id))}
        >
          Archive
        </button>
      )}
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
