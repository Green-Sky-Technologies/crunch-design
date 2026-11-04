'use client';

/** Named versions (Story 6.2): save, list, restore and side-by-side compare. */
import { useCallback, useEffect, useState } from 'react';
import { useDocStoreApi, useEditor } from '../doc-store';
import { fmtTime } from './comments-panel';
import { CompareView } from './compare-view';
import { versionLabel, versionsApi, type VersionItem } from './versions-api';

export function VersionsPanel() {
  const { project, can } = useEditor();
  const store = useDocStoreApi();
  const [versions, setVersions] = useState<VersionItem[] | null>(null);
  const [includeAuto, setIncludeAuto] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comparing, setComparing] = useState<VersionItem | null>(null);
  const canEdit = can('design:edit');

  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);
  useEffect(() => {
    let live = true;
    versionsApi
      .list(project.id, includeAuto)
      .then((r) => live && setVersions(r.versions))
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Failed to load versions'));
    return () => {
      live = false;
    };
  }, [project.id, includeAuto, reloadKey]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // Save pending edits first so the version captures what the user sees.
      await store.getState().flush();
      await versionsApi.create(project.id, name, description);
      setName('');
      setDescription('');
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save version');
    } finally {
      setBusy(false);
    }
  };

  const restore = async (v: VersionItem) => {
    if (!window.confirm(`Restore “${versionLabel(v)}”? The current state is backed up first.`))
      return;
    setBusy(true);
    setError(null);
    try {
      await store.getState().flush();
      await versionsApi.restore(project.id, v.id);
      await store.getState().reload();
      setComparing(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not restore');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {canEdit && (
        <form
          className="space-y-2 border-b border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            className="input"
            placeholder="Version name, e.g. “Ready for review”"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
          <textarea
            className="input min-h-12"
            placeholder="Notes (optional)"
            value={description}
            maxLength={2000}
            onChange={(e) => setDescription(e.target.value)}
          />
          <button className="btn-primary w-full" disabled={busy || !name.trim()}>
            Save version
          </button>
        </form>
      )}
      <label className="flex items-center gap-2 px-3 py-2 text-xs text-muted">
        <input
          type="checkbox"
          checked={includeAuto}
          onChange={(e) => setIncludeAuto(e.target.checked)}
        />
        Show automatic snapshots
      </label>
      {error && <p className="px-3 text-xs text-danger">{error}</p>}
      <ul className="min-h-0 flex-1 overflow-auto">
        {versions === null && <li className="p-3 text-muted">Loading…</li>}
        {versions?.length === 0 && (
          <li className="p-3 text-muted">
            No versions yet.{canEdit ? ' Save one to mark a milestone.' : ''}
          </li>
        )}
        {versions?.map((v) => (
          <li key={v.id} className="border-b border-border p-3">
            <div className="flex items-baseline gap-2">
              <span className={`font-medium ${v.kind === 'auto' ? 'text-muted' : ''}`}>
                {versionLabel(v)}
              </span>
              <span className="ml-auto shrink-0 text-xs text-muted">v{v.docVersion}</span>
            </div>
            <div className="text-xs text-muted">
              {fmtTime(v.createdAt)}
              {v.createdByName ? ` · ${v.createdByName}` : ''}
            </div>
            {v.description && <p className="mt-1 whitespace-pre-wrap text-xs">{v.description}</p>}
            <div className="mt-2 flex gap-2">
              <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => setComparing(v)}>
                Compare
              </button>
              {canEdit && (
                <button
                  className="btn-ghost px-2 py-0.5 text-xs"
                  disabled={busy}
                  onClick={() => void restore(v)}
                >
                  Restore
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {comparing && versions && (
        <CompareView
          base={comparing}
          versions={versions}
          onClose={() => setComparing(null)}
          onRestore={canEdit ? (v) => void restore(v) : undefined}
        />
      )}
    </div>
  );
}
