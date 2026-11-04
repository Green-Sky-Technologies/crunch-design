'use client';

/**
 * Export menu (Epic 7, deterministic exports). Viewers may export (export:deterministic).
 * Reads everything from useEditor() / useDocStore(); no props (editor-shell slot).
 */
import { useEffect, useRef, useState } from 'react';
import { useDocStore, useDocStoreApi, useEditor } from '../doc-store';

export interface ExportItem {
  format: string;
  label: string;
  hint: string;
}

export const EXPORT_ITEMS: ExportItem[] = [
  { format: 'html', label: 'HTML page', hint: 'One standalone .html file' },
  { format: 'zip', label: 'ZIP (HTML + assets)', hint: 'Opens offline; one page per frame' },
  {
    format: 'handoff-zip',
    label: 'Handoff bundle (ZIP)',
    hint: 'handoff.json + schema + reference HTML for a coding agent',
  },
  { format: 'handoff', label: 'Handoff JSON', hint: 'Just handoff.json' },
];

export function exportUrl(
  projectId: string,
  format: string,
  opts: { frameIds?: string[]; versionId?: string } = {},
): string {
  const sp = new URLSearchParams({ format });
  if (opts.frameIds?.length) sp.set('frameIds', opts.frameIds.join(','));
  if (opts.versionId) sp.set('versionId', opts.versionId);
  return `/api/export/${projectId}?${sp.toString()}`;
}

export function ExportMenu() {
  const { project, can } = useEditor();
  const store = useDocStoreApi();
  const frames = useDocStore((s) => s.doc.frames);
  const selectedFrame = useDocStore((s) => s.selection.frameId);
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<'all' | 'frame'>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!can('export:deterministic')) return null;
  const frameId = selectedFrame ?? frames[0]?.id;
  const frameName = frames.find((f) => f.id === frameId)?.name;

  const download = async (format: string) => {
    setBusy(format);
    setError(null);
    try {
      // Export what the user sees: push pending edits first (no-op for viewers).
      await store.getState().flush();
      const url = exportUrl(project.id, format, {
        frameIds: scope === 'frame' && frameId ? [frameId] : undefined,
      });
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(b?.message ?? `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const name =
        /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
        `export.${format}`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        className="btn-ghost px-2 py-1"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        disabled={!frames.length}
        title={frames.length ? undefined : 'Nothing to export yet'}
      >
        Export
      </button>
      {open && (
        <div role="menu" className="card absolute right-0 z-50 mt-1 w-72 p-2 text-sm shadow-lg">
          {frames.length > 1 && (
            <div className="mb-2 flex gap-1 text-xs" role="radiogroup" aria-label="Frames">
              {(['all', 'frame'] as const).map((s) => (
                <button
                  key={s}
                  role="radio"
                  aria-checked={scope === s}
                  className={`flex-1 truncate rounded px-2 py-1 ${scope === s ? 'bg-surface-2 font-medium' : 'text-muted'}`}
                  onClick={() => setScope(s)}
                >
                  {s === 'all' ? 'All frames' : (frameName ?? 'Current frame')}
                </button>
              ))}
            </div>
          )}
          {EXPORT_ITEMS.map((it) => (
            <button
              key={it.format}
              role="menuitem"
              className="block w-full rounded px-2 py-1.5 text-left hover:bg-surface-2 disabled:opacity-50"
              disabled={busy !== null}
              onClick={() => void download(it.format)}
            >
              <span className="font-medium">{busy === it.format ? 'Preparing…' : it.label}</span>
              <span className="block text-xs text-muted">{it.hint}</span>
            </button>
          ))}
          {error && <p className="px-2 pt-1 text-xs text-danger">{error}</p>}
        </div>
      )}
    </div>
  );
}
