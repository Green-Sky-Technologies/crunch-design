'use client';

/**
 * Side-by-side visual compare of a version against the current design or another version
 * (Story 6.2). Both sides use the live FrameView renderer; a structural diff lists what changed.
 */
import type { DesignDoc } from '@crunch/doc-model';
import { FrameView } from '@crunch/renderer/react';
import { useEffect, useMemo, useState } from 'react';
import { useDocStore, useEditor } from '../doc-store';
import { nodeLabel } from './comments-panel';
import { diffDocs } from './version-diff';
import { versionLabel, versionsApi, type VersionItem } from './versions-api';

const CURRENT = 'current';
const VIEW_OPTIONS = { annotate: false, showHidden: false };

function Side({
  title,
  doc,
  frameId,
  width,
}: {
  title: string;
  doc: DesignDoc | null;
  frameId: string;
  width: number;
}) {
  const { designSystem } = useEditor();
  const frame = doc?.frames.find((f) => f.id === frameId);
  const scale = frame ? Math.min(1, width / frame.width) : 1;
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-2 text-xs font-medium text-muted">{title}</div>
      <div className="overflow-hidden rounded border border-border bg-white" style={{ width }}>
        {!doc ? (
          <p className="p-6 text-sm text-muted">Loading…</p>
        ) : !frame ? (
          <p className="p-6 text-sm text-muted">This frame doesn&apos;t exist here.</p>
        ) : (
          <div
            style={{
              width: frame.width,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
              height: 'auto',
            }}
          >
            <FrameView doc={doc} ds={designSystem.spec} frameId={frame.id} options={VIEW_OPTIONS} />
          </div>
        )}
      </div>
    </div>
  );
}

export function CompareView({
  base,
  versions,
  onClose,
  onRestore,
}: {
  base: VersionItem;
  versions: VersionItem[];
  onClose: () => void;
  onRestore?: (v: VersionItem) => void;
}) {
  const { project } = useEditor();
  const currentDoc = useDocStore((s) => s.doc);
  const [otherId, setOtherId] = useState<string>(CURRENT);
  const [docs, setDocs] = useState<Record<string, DesignDoc>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const need = [base.id, otherId].filter((id) => id !== CURRENT && !docs[id]);
    let live = true;
    for (const id of need)
      versionsApi
        .get(project.id, id)
        .then((r) => live && setDocs((d) => ({ ...d, [id]: r.doc })))
        .catch((e) => live && setError(e instanceof Error ? e.message : 'Failed to load'));
    return () => {
      live = false;
    };
  }, [base.id, otherId, docs, project.id]);

  const left = docs[base.id] ?? null;
  const right = otherId === CURRENT ? currentDoc : (docs[otherId] ?? null);
  const diff = useMemo(() => (left && right ? diffDocs(left, right) : []), [left, right]);
  const [frameId, setFrameId] = useState<string | null>(null);
  const activeFrame =
    frameId ?? diff.find((d) => d.status !== 'unchanged')?.frameId ?? diff[0]?.frameId;
  const active = diff.find((d) => d.frameId === activeFrame);
  const [vw, setVw] = useState(1200);
  useEffect(() => {
    const on = () => setVw(window.innerWidth);
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const sideWidth = Math.max(240, Math.floor((vw - 360 - 96) / 2));

  const otherLabel =
    otherId === CURRENT
      ? 'Current design'
      : versionLabel(versions.find((v) => v.id === otherId) ?? base);

  return (
    <div
      role="dialog"
      aria-label="Compare versions"
      className="fixed inset-0 z-50 flex flex-col bg-bg text-sm"
    >
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
        <span className="font-medium">Compare</span>
        <span className="text-muted">{versionLabel(base)}</span>
        <span className="text-muted">→</span>
        <select
          className="input w-auto py-1"
          value={otherId}
          onChange={(e) => setOtherId(e.target.value)}
          aria-label="Compare with"
        >
          <option value={CURRENT}>Current design</option>
          {versions
            .filter((v) => v.id !== base.id)
            .map((v) => (
              <option key={v.id} value={v.id}>
                {versionLabel(v)} (v{v.docVersion})
              </option>
            ))}
        </select>
        {onRestore && (
          <button className="btn-ghost ml-auto" onClick={() => onRestore(base)}>
            Restore “{versionLabel(base)}”
          </button>
        )}
        <button className={`btn-ghost ${onRestore ? '' : 'ml-auto'}`} onClick={onClose}>
          Close
        </button>
      </div>
      {error && <p className="px-4 py-2 text-danger">{error}</p>}
      <div className="flex min-h-0 flex-1">
        <nav className="w-[360px] shrink-0 overflow-auto border-r border-border bg-surface p-3">
          <h3 className="mb-2 text-xs font-medium uppercase text-muted">Frames</h3>
          <ul className="space-y-1">
            {diff.map((d) => (
              <li key={d.frameId}>
                <button
                  className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left ${d.frameId === activeFrame ? 'bg-surface-2' : ''}`}
                  onClick={() => setFrameId(d.frameId)}
                >
                  <span className="truncate">{d.name}</span>
                  <span
                    className={`ml-auto text-[10px] uppercase ${d.status === 'unchanged' ? 'text-muted' : 'text-accent'}`}
                  >
                    {d.status}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {active && active.status !== 'unchanged' && left && right && (
            <div className="mt-4 space-y-3 text-xs">
              {(
                [
                  ['Added', active.added, right],
                  ['Removed', active.removed, left],
                  ['Changed', active.changed, right],
                ] as const
              ).map(([label, ids, doc]) =>
                ids.length ? (
                  <div key={label}>
                    <div className="mb-1 font-medium">
                      {label} ({ids.length})
                    </div>
                    <ul className="space-y-0.5 text-muted">
                      {ids.slice(0, 50).map((id) => (
                        <li key={id} className="truncate">
                          {nodeLabel(doc, id)}
                        </li>
                      ))}
                      {ids.length > 50 && <li>…and {ids.length - 50} more</li>}
                    </ul>
                  </div>
                ) : null,
              )}
            </div>
          )}
        </nav>
        <div className="flex min-w-0 flex-1 gap-6 overflow-auto p-6">
          {activeFrame ? (
            <>
              <Side
                title={`${versionLabel(base)} (v${base.docVersion})`}
                doc={left}
                frameId={activeFrame}
                width={sideWidth}
              />
              <Side title={otherLabel} doc={right} frameId={activeFrame} width={sideWidth} />
            </>
          ) : (
            <p className="text-muted">Nothing to compare.</p>
          )}
        </div>
      </div>
    </div>
  );
}
