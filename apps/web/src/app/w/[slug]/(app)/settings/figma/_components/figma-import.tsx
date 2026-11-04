'use client';

import type { ReportItem } from '@crunch/figma-convert';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import {
  deleteFigmaTokenAction,
  importFigmaUrlAction,
  saveFigmaTokenAction,
} from '@/server/actions/figma';
import type { PublicFigmaCredential } from '@/server/services/figma/credentials';

/** The caller's Figma personal access token (used for REST imports). Never shown after saving. */
export function FigmaToken({ initial }: { initial: PublicFigmaCredential | null }) {
  const [cred, setCred] = useState(initial);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="card p-5">
      <h2 className="font-medium">Figma access token</h2>
      <p className="mt-1 text-sm text-muted">
        Needed to import from a Figma link. Create a personal access token in Figma (Settings →
        Security) with read access to files. It&apos;s stored encrypted, for your account only.
      </p>
      {cred ? (
        <div className="mt-4 flex items-center gap-3 text-sm">
          <span className="font-mono">{cred.hint}</span>
          {cred.figmaUserHandle && <span className="text-muted">as {cred.figmaUserHandle}</span>}
          <button
            className="btn-danger ml-auto"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const res = await deleteFigmaTokenAction();
                if (res.ok) setCred(null);
                else setError(res.error);
              })
            }
          >
            Remove
          </button>
        </div>
      ) : (
        <form
          className="mt-4 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const res = await saveFigmaTokenAction(token);
              if (res.ok) {
                setCred(res.data);
                setToken('');
                setError(null);
              } else setError(res.error);
            });
          }}
        >
          <div className="flex-1">
            <label className="label" htmlFor="figma-token">
              Personal access token
            </label>
            <input
              id="figma-token"
              className="input font-mono"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          <button className="btn-primary" disabled={pending || !token.trim()}>
            {pending ? 'Verifying…' : 'Save'}
          </button>
        </form>
      )}
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
    </div>
  );
}

interface ImportProps {
  projects: { id: string; name: string }[];
  slug: string;
  canEdit: boolean;
  hasToken: boolean;
}

/** Import a Figma file/frame link into a project, then show the fidelity report. */
export function FigmaImport({ projects, slug, canEdit, hasToken }: ImportProps) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    frames: { id: string; name: string }[];
    report: ReportItem[];
  } | null>(null);
  const [pending, start] = useTransition();
  const disabled = !canEdit || !hasToken || pending || !projectId || !url.trim();

  return (
    <div className="card p-5">
      <h2 className="font-medium">Import from Figma</h2>
      <p className="mt-1 text-sm text-muted">
        Paste a file or frame link. Frames are converted once (auto-layout → flow, styles → style
        props, matching variables → tokens, vectors → SVG) and added as new frames. You can also
        import the current selection from the plugin.
      </p>
      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const res = await importFigmaUrlAction(projectId, url);
            if (res.ok) {
              setResult(res.data);
              setError(null);
            } else setError(res.error);
          });
        }}
      >
        <div>
          <label className="label" htmlFor="import-project">
            Project
          </label>
          <select
            id="import-project"
            className="input"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="import-url">
            Figma link
          </label>
          <input
            id="import-url"
            className="input"
            placeholder="https://www.figma.com/design/…?node-id=1-2"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-3">
          <button className="btn-primary" disabled={disabled}>
            {pending ? 'Importing…' : 'Import'}
          </button>
          {!hasToken && <span className="text-sm text-muted">Add a Figma token first.</span>}
          {!canEdit && <span className="text-sm text-muted">Editors and Admins can import.</span>}
        </div>
      </form>
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
      {result && (
        <div className="mt-4 text-sm">
          <p>
            Imported {result.frames.map((f) => f.name).join(', ')} ·{' '}
            <Link className="underline" href={`/w/${slug}/p/${projectId}`}>
              open project
            </Link>
          </p>
          <ReportList items={result.report} />
        </div>
      )}
    </div>
  );
}

export function ReportList({ items }: { items: ReportItem[] }) {
  if (!items.length) return <p className="mt-2 text-muted">Everything was represented.</p>;
  return (
    <ul className="mt-2 max-h-64 overflow-auto rounded-md border border-border p-2 text-xs">
      {items.map((i, k) => (
        <li
          key={k}
          className={
            i.severity === 'error' ? 'text-danger' : i.severity === 'warning' ? '' : 'text-muted'
          }
        >
          {i.severity === 'error' ? '✕' : i.severity === 'warning' ? '!' : '·'} {i.message}
          {i.subject && <code className="ml-1">{i.subject}</code>}
          {i.nodeName && <span className="text-muted"> — {i.nodeName}</span>}
          {(i.count ?? 1) > 1 && <span className="text-muted"> ×{i.count}</span>}
        </li>
      ))}
    </ul>
  );
}
