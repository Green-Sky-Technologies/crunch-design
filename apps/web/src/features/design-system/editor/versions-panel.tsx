'use client';

import type { DesignSystemSpec } from '@crunch/doc-model';
import { useState, useTransition } from 'react';
import { getDesignSystemVersionSpecAction } from '@/server/actions/design-systems';

export interface VersionItem {
  id: string;
  version: number;
  notes: string | null;
  publishedBy: string;
  publishedAt: Date | string;
}

/** Published versions are immutable. Loading one copies it into the working draft. */
export function VersionsPanel({
  systemId,
  versions,
  canEdit,
  onLoad,
}: {
  systemId: string;
  versions: VersionItem[];
  canEdit: boolean;
  onLoad: (spec: DesignSystemSpec, version: number) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!versions.length)
    return (
      <p className="text-sm text-muted">
        Nothing published yet. Projects use the draft until the first publish; after that they pin a
        version and only change when you upgrade them.
      </p>
    );
  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-danger">{error}</p>}
      <ol className="card divide-y divide-border">
        {versions.map((v, i) => (
          <li key={v.id} className="flex items-start justify-between gap-4 px-3 py-3">
            <div>
              <p className="text-sm font-medium">
                v{v.version}
                {i === 0 && <span className="ml-2 text-xs font-normal text-ok">latest</span>}
              </p>
              <p className="text-xs text-muted">
                {new Date(v.publishedAt).toLocaleString()}
                {v.notes ? ` · ${v.notes}` : ''}
              </p>
            </div>
            {canEdit && (
              <button
                type="button"
                className="btn-ghost text-xs"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const res = await getDesignSystemVersionSpecAction(systemId, v.version);
                    if (!res.ok) return setError(res.error);
                    setError(null);
                    onLoad(res.data, v.version);
                  })
                }
              >
                Load into draft
              </button>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
