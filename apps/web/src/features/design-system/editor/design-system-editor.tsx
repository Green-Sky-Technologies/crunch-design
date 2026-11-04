'use client';

import type { DesignSystemSpec } from '@crunch/doc-model';
import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import {
  discardDesignSystemDraftAction,
  publishDesignSystemAction,
  saveDesignSystemDraftAction,
  updateDesignSystemDetailsAction,
} from '@/server/actions/design-systems';
import { safeParseSpec, specsEqual } from '@/server/services/design-systems/spec';
import { ComponentsPanel } from './components-panel';
import { PreviewPanel } from './preview-panel';
import { SettingsPanel } from './settings-panel';
import { ThemesPanel } from './themes-panel';
import { TokensPanel } from './tokens-panel';
import { VersionsPanel, type VersionItem } from './versions-panel';

export interface EditorSystem {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  latestVersion: number | null;
  /** The saved draft differs from the latest published version. */
  hasUnpublishedChanges: boolean;
  revision: string;
}

const TABS = ['Tokens', 'Components', 'Themes', 'Settings', 'Versions'] as const;
type Tab = (typeof TABS)[number];

export function DesignSystemEditor({
  workspaceSlug,
  system,
  initialDraft,
  versions = [],
  canEdit,
}: {
  workspaceSlug: string;
  system: EditorSystem;
  initialDraft: DesignSystemSpec;
  versions?: VersionItem[];
  canEdit: boolean;
}) {
  const [spec, setSpec] = useState(initialDraft);
  const [saved, setSaved] = useState(initialDraft);
  const [previewSpec, setPreviewSpec] = useState(initialDraft);
  const [revision, setRevision] = useState(system.revision);
  const [name, setName] = useState(system.name);
  const [tab, setTab] = useState<Tab>('Tokens');
  const [theme, setTheme] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [publishing, setPublishing] = useState(false);
  const [notes, setNotes] = useState('');

  const validity = useMemo(() => safeParseSpec(spec), [spec]);
  const issues = validity.ok ? [] : validity.issues;
  const dirty = useMemo(() => !specsEqual(spec, saved), [spec, saved]);

  const apply = (next: DesignSystemSpec) => {
    setSpec(next);
    const r = safeParseSpec(next);
    if (r.ok) setPreviewSpec(r.spec);
  };

  const update = (fn: (draft: DesignSystemSpec) => void) => {
    const next = structuredClone(spec);
    fn(next);
    setSpec(next);
    const r = safeParseSpec(next);
    if (r.ok) setPreviewSpec(r.spec);
    setNotice(null);
  };

  const save = () =>
    start(async () => {
      const res = await saveDesignSystemDraftAction(system.id, spec, revision);
      if (!res.ok) return setError(res.error);
      loadSaved(res.data);
      setError(null);
      setNotice('Draft saved. Projects keep their pinned version until you publish.');
    });

  const loadSaved = (data: { revision: string; spec: DesignSystemSpec }) => {
    setRevision(data.revision);
    setSaved(data.spec);
    setSpec(data.spec);
    setPreviewSpec(data.spec);
  };

  const publish = () =>
    start(async () => {
      const res = await publishDesignSystemAction(system.id, notes || undefined, revision);
      if (!res.ok) return setError(res.error);
      setRevision(res.data.revision);
      setPublishing(false);
      setNotes('');
      setError(null);
      setNotice(
        `Published v${res.data.version}. Projects on older versions will see an upgrade prompt.`,
      );
    });

  const discard = () =>
    start(async () => {
      const res = await discardDesignSystemDraftAction(system.id);
      if (!res.ok) return setError(res.error);
      loadSaved(res.data);
      setError(null);
      setNotice(`Draft reset to v${system.latestVersion}.`);
    });

  const canPublish = !dirty && validity.ok && system.hasUnpublishedChanges;

  const rename = () => {
    if (name.trim() === system.name || !name.trim()) return;
    start(async () => {
      const res = await updateDesignSystemDetailsAction(system.id, { name });
      if (!res.ok) setError(res.error);
    });
  };

  const panelProps = { spec, update, issues, canEdit };

  return (
    <main className="mx-auto w-full max-w-[1400px] px-6 py-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link
          href={`/w/${workspaceSlug}/design-systems`}
          className="text-sm text-muted hover:text-text"
        >
          ← Design systems
        </Link>
      </div>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          {canEdit ? (
            <input
              aria-label="Design system name"
              className="-ml-1 rounded-md bg-transparent px-1 text-2xl font-semibold tracking-tight outline-none focus:ring-2 focus:ring-accent/20"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              onBlur={rename}
            />
          ) : (
            <h1 className="text-2xl font-semibold tracking-tight">{system.name}</h1>
          )}
          <p className="mt-1 text-sm text-muted">
            {system.isDefault ? 'Workspace default · ' : ''}
            {system.latestVersion === null
              ? 'Never published'
              : `Published v${system.latestVersion}`}
            {dirty
              ? ' · Unsaved changes'
              : system.hasUnpublishedChanges && system.latestVersion !== null
                ? ' · Draft has unpublished changes'
                : ''}
          </p>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-ghost"
              disabled={!dirty || pending}
              onClick={() => {
                setSpec(saved);
                setPreviewSpec(saved);
              }}
            >
              Revert
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!dirty || !validity.ok || pending}
              onClick={save}
            >
              {pending ? 'Saving…' : 'Save draft'}
            </button>
            {system.latestVersion !== null && system.hasUnpublishedChanges && !dirty && (
              <button type="button" className="btn-ghost" disabled={pending} onClick={discard}>
                Discard draft changes
              </button>
            )}
            <button
              type="button"
              className="btn-ghost"
              disabled={!canPublish || pending}
              title={dirty ? 'Save the draft first' : undefined}
              onClick={() => setPublishing(true)}
            >
              Publish…
            </button>
          </div>
        )}
      </header>

      {publishing && (
        <div className="card mb-4 space-y-3 p-4" role="dialog" aria-label="Publish version">
          <p className="text-sm">
            Publish the saved draft as <strong>v{(system.latestVersion ?? 0) + 1}</strong>.
            Published versions can&apos;t change. Projects stay on their current version until
            someone upgrades them.
          </p>
          <textarea
            aria-label="Release notes"
            className="input min-h-20"
            placeholder="What changed? (optional)"
            maxLength={2000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <div className="flex gap-2">
            <button type="button" className="btn-primary" disabled={pending} onClick={publish}>
              {pending ? 'Publishing…' : 'Publish'}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setPublishing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="mb-4 rounded-md bg-surface-2 p-3 text-sm text-danger">{error}</p>}
      {notice && <p className="mb-4 rounded-md bg-surface-2 p-3 text-sm text-ok">{notice}</p>}
      {!validity.ok && (
        <p className="mb-4 rounded-md bg-surface-2 p-3 text-sm text-danger">
          {issues.length} problem{issues.length === 1 ? '' : 's'} to fix before saving:{' '}
          {issues[0]!.path} {issues[0]!.message}
        </p>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_680px]">
        <div className="min-w-0">
          <nav className="mb-5 flex gap-1 border-b border-border text-sm" role="tablist">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={`-mb-px border-b-2 px-3 py-2 ${tab === t ? 'border-accent font-medium' : 'border-transparent text-muted hover:text-text'}`}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </nav>
          <fieldset disabled={!canEdit} className="min-w-0">
            {tab === 'Tokens' && <TokensPanel {...panelProps} />}
            {tab === 'Themes' && <ThemesPanel {...panelProps} />}
            {tab === 'Settings' && <SettingsPanel {...panelProps} />}
          </fieldset>
          {tab === 'Versions' && (
            <VersionsPanel
              systemId={system.id}
              versions={versions}
              canEdit={canEdit}
              onLoad={(next, v) => {
                apply(next);
                setNotice(`Loaded v${v} into the editor. Save the draft to keep it.`);
              }}
            />
          )}
          {tab === 'Components' && (
            <ComponentsPanel {...panelProps} previewSpec={previewSpec} theme={theme} />
          )}
        </div>
        <div className="xl:sticky xl:top-4 xl:self-start">
          <PreviewPanel spec={previewSpec} theme={theme} onTheme={setTheme} stale={!validity.ok} />
        </div>
      </div>
    </main>
  );
}
