'use client';

/**
 * Share links (Story 6.3): create workspace-only (default) or public view-only links with an
 * optional expiry, pin to a version or a subset of frames, change visibility, and revoke.
 * The full URL is shown once, right after creation (only a hash is stored).
 */
import { useEffect, useState } from 'react';
import { useDocStore, useEditor } from '../doc-store';
import { request } from './api';
import { fmtTime } from './comments-panel';
import { versionLabel, versionsApi, type VersionItem } from './versions-api';

export interface ShareLinkItem {
  id: string;
  visibility: 'workspace' | 'public';
  frameIds: string[] | null;
  docVersionId: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  createdAt: string;
  active: boolean;
}

const shareApi = {
  list: (projectId: string) =>
    request<{ links: ShareLinkItem[] }>(`/api/share?projectId=${encodeURIComponent(projectId)}`),
  create: (input: {
    projectId: string;
    visibility: 'workspace' | 'public';
    expiresAt: string | null;
    frameIds: string[] | null;
    docVersionId: string | null;
  }) =>
    request<{ link: ShareLinkItem; token: string; path: string }>('/api/share', {
      method: 'POST',
      json: input,
    }),
  update: (id: string, patch: { visibility?: 'workspace' | 'public'; expiresAt?: string | null }) =>
    request<{ link: ShareLinkItem }>(`/api/share/${id}`, { method: 'PATCH', json: patch }),
  revoke: (id: string) =>
    request<{ link: ShareLinkItem }>(`/api/share/${id}`, { method: 'DELETE' }),
};

const EXPIRY = [
  { label: 'Never expires', days: 0 },
  { label: 'Expires in 1 day', days: 1 },
  { label: 'Expires in 7 days', days: 7 },
  { label: 'Expires in 30 days', days: 30 },
];

function CopyField({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <input
        className="input font-mono text-xs"
        readOnly
        value={url}
        onFocus={(e) => e.target.select()}
      />
      <button
        className="btn-ghost shrink-0"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // clipboard blocked: the field is selectable
          }
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function SharePanel() {
  const { project, can } = useEditor();
  const frames = useDocStore((s) => s.doc.frames);
  const [links, setLinks] = useState<ShareLinkItem[] | null>(null);
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [visibility, setVisibility] = useState<'workspace' | 'public'>('workspace');
  const [days, setDays] = useState(0);
  const [versionId, setVersionId] = useState('');
  const [frameSel, setFrameSel] = useState<string[] | null>(null);
  const [created, setCreated] = useState<{ url: string; visibility: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const canManage = can('share:manage');

  useEffect(() => {
    if (!canManage) return;
    let live = true;
    shareApi
      .list(project.id)
      .then((r) => live && setLinks(r.links))
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Failed to load'));
    versionsApi
      .list(project.id, false)
      .then((r) => live && setVersions(r.versions))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [project.id, canManage, reloadKey]);

  if (!canManage)
    return (
      <p className="p-3 text-muted">
        Only editors can create share links. Ask an editor for a link to this design.
      </p>
    );

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    run(async () => {
      const r = await shareApi.create({
        projectId: project.id,
        visibility,
        expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
        frameIds: frameSel && frameSel.length ? frameSel : null,
        docVersionId: versionId || null,
      });
      setCreated({ url: `${window.location.origin}${r.path}`, visibility });
    });

  return (
    <div>
      <div className="space-y-3 border-b border-border p-3">
        <fieldset className="space-y-1">
          <legend className="label">Who can open it</legend>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="share-visibility"
              checked={visibility === 'workspace'}
              onChange={() => setVisibility('workspace')}
            />
            <span>
              Workspace members
              <span className="block text-xs text-muted">Signed-in members of this workspace</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="share-visibility"
              checked={visibility === 'public'}
              onChange={() => setVisibility('public')}
            />
            <span>
              Anyone with the link
              <span className="block text-xs text-muted">
                View-only; shows the design only, no workspace details
              </span>
            </span>
          </label>
        </fieldset>
        <select
          className="input"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          aria-label="Expiry"
        >
          {EXPIRY.map((o) => (
            <option key={o.days} value={o.days}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={versionId}
          onChange={(e) => setVersionId(e.target.value)}
          aria-label="Version"
        >
          <option value="">Live design (updates as you edit)</option>
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              Version: {versionLabel(v)}
            </option>
          ))}
        </select>
        {frames.length > 1 && (
          <details>
            <summary className="cursor-pointer text-xs text-muted">
              {frameSel?.length ? `${frameSel.length} frame(s) selected` : 'All frames'}
            </summary>
            <ul className="mt-1 space-y-1">
              {frames.map((f) => (
                <li key={f.id}>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={frameSel?.includes(f.id) ?? false}
                      onChange={(e) =>
                        setFrameSel((s) =>
                          e.target.checked
                            ? [...(s ?? []), f.id]
                            : (s ?? []).filter((x) => x !== f.id),
                        )
                      }
                    />
                    {f.name}
                  </label>
                </li>
              ))}
            </ul>
          </details>
        )}
        <button className="btn-primary w-full" disabled={busy} onClick={() => void create()}>
          Create link
        </button>
        {created && (
          <div className="space-y-1 rounded bg-surface-2 p-2" role="status">
            <p className="text-xs">
              {created.visibility === 'public' ? 'Public' : 'Workspace'} link created. Copy it now:
              it won&apos;t be shown again.
            </p>
            <CopyField url={created.url} />
          </div>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
      <ul>
        {links === null && <li className="p-3 text-muted">Loading…</li>}
        {links?.length === 0 && <li className="p-3 text-muted">No links yet.</li>}
        {links?.map((l) => (
          <li key={l.id} className={`border-b border-border p-3 ${l.active ? '' : 'opacity-60'}`}>
            <div className="flex items-center gap-2">
              <span className="font-medium">
                {l.visibility === 'public' ? 'Anyone with the link' : 'Workspace members'}
              </span>
              <span className="ml-auto text-xs text-muted">
                {l.revokedAt
                  ? 'Revoked'
                  : !l.active
                    ? 'Expired'
                    : l.expiresAt
                      ? `Until ${fmtTime(l.expiresAt)}`
                      : 'No expiry'}
              </span>
            </div>
            <div className="text-xs text-muted">
              Created {fmtTime(l.createdAt)} · {l.viewCount} view{l.viewCount === 1 ? '' : 's'}
              {l.docVersionId ? ' · pinned version' : ''}
              {l.frameIds ? ` · ${l.frameIds.length} frame(s)` : ''}
            </div>
            {!l.revokedAt && (
              <div className="mt-2 flex gap-2">
                <button
                  className="btn-ghost px-2 py-0.5 text-xs"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      shareApi.update(l.id, {
                        visibility: l.visibility === 'public' ? 'workspace' : 'public',
                      }),
                    )
                  }
                >
                  {l.visibility === 'public' ? 'Make workspace-only' : 'Make public'}
                </button>
                <button
                  className="btn-danger px-2 py-0.5 text-xs"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm('Revoke this link? Anyone using it loses access.'))
                      void run(() => shareApi.revoke(l.id));
                  }}
                >
                  Revoke
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
