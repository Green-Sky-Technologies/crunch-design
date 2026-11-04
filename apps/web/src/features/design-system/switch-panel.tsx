'use client';

import { useState, useTransition } from 'react';
import {
  previewDesignSystemSwitchAction,
  switchProjectDesignSystemAction,
} from '@/server/actions/design-systems';
import type { SwitchPreview } from '@/server/services/project-design-system';
import { DiffView } from './diff-view';

export interface SystemOption {
  id: string;
  name: string;
  latestVersion: number | null;
}

/** Story 4.3: pick another system (and version), preview what changes, then switch. */
export function SwitchPanel({
  projectId,
  currentSystemId,
  currentVersion,
  systems,
  onDone,
}: {
  projectId: string;
  currentSystemId: string;
  currentVersion: number | null;
  systems: SystemOption[];
  onDone: () => void;
}) {
  const [systemId, setSystemId] = useState(
    systems.find((s) => s.id !== currentSystemId)?.id ?? currentSystemId,
  );
  const system = systems.find((s) => s.id === systemId);
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [preview, setPreview] = useState<SwitchPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const target = { designSystemId: systemId, version };
  const same =
    systemId === currentSystemId && (version ?? system?.latestVersion) === currentVersion;

  const runPreview = () =>
    start(async () => {
      const res = await previewDesignSystemSwitchAction(projectId, target);
      if (!res.ok) return setError(res.error);
      setError(null);
      setPreview(res.data);
    });

  const doSwitch = () =>
    start(async () => {
      const res = await switchProjectDesignSystemAction(projectId, target);
      if (!res.ok) return setError(res.error);
      onDone();
    });

  const versions = system?.latestVersion
    ? Array.from({ length: system.latestVersion }, (_, i) => system.latestVersion! - i)
    : [];

  return (
    <div className="space-y-3 rounded-md bg-surface-2 p-3" aria-label="Change design system">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">
          <span className="mb-1 block text-muted">Design system</span>
          <select
            className="input w-56"
            value={systemId}
            onChange={(e) => {
              setSystemId(e.target.value);
              setVersion(undefined);
              setPreview(null);
            }}
          >
            {systems.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.id === currentSystemId ? ' (current)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted">Version</span>
          <select
            className="input w-44"
            value={version ?? ''}
            onChange={(e) => {
              setVersion(e.target.value ? Number(e.target.value) : undefined);
              setPreview(null);
            }}
          >
            {versions.length ? (
              <>
                <option value="">Latest (v{system!.latestVersion})</option>
                {versions.slice(1).map((v) => (
                  <option key={v} value={v}>
                    v{v}
                  </option>
                ))}
              </>
            ) : (
              <option value="">Draft (unpublished)</option>
            )}
          </select>
        </label>
        <button type="button" className="btn-ghost" disabled={pending || same} onClick={runPreview}>
          Preview changes
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={pending || same || !preview}
          title={preview ? undefined : 'Preview the changes first'}
          onClick={doSwitch}
        >
          Switch
        </button>
        <button type="button" className="btn-ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {preview && (
        <div className="rounded-md bg-surface p-3">
          <p className="mb-2 text-xs text-muted">
            {preview.current.name}
            {preview.current.version ? ` v${preview.current.version}` : ' (draft)'} →{' '}
            {preview.target.name}
            {preview.target.version ? ` v${preview.target.version}` : ' (draft)'}
          </p>
          <DiffView diff={preview.diff} />
        </div>
      )}
    </div>
  );
}
