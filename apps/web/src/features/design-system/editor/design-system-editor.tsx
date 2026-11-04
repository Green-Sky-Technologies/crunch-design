'use client';

import type { DesignSystemSpec } from '@crunch/doc-model';
import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import {
  saveDesignSystemDraftAction,
  updateDesignSystemDetailsAction,
} from '@/server/actions/design-systems';
import { safeParseSpec, specsEqual } from '@/server/services/design-systems/spec';
import { ComponentsPanel } from './components-panel';
import { PreviewPanel } from './preview-panel';
import { SettingsPanel } from './settings-panel';
import { ThemesPanel } from './themes-panel';
import { TokensPanel } from './tokens-panel';

export interface EditorSystem {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  latestVersion: number | null;
  revision: string;
}

const TABS = ['Tokens', 'Components', 'Themes', 'Settings'] as const;
type Tab = (typeof TABS)[number];

export function DesignSystemEditor({
  workspaceSlug,
  system,
  initialDraft,
  canEdit,
}: {
  workspaceSlug: string;
  system: EditorSystem;
  initialDraft: DesignSystemSpec;
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

  const validity = useMemo(() => safeParseSpec(spec), [spec]);
  const issues = validity.ok ? [] : validity.issues;
  const dirty = useMemo(() => !specsEqual(spec, saved), [spec, saved]);

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
      setRevision(res.data.revision);
      setSaved(res.data.spec);
      setSpec(res.data.spec);
      setPreviewSpec(res.data.spec);
      setError(null);
      setNotice('Draft saved. Projects keep their pinned version until you publish.');
    });

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
            {dirty ? ' · Unsaved changes' : ''}
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
          </div>
        )}
      </header>

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
