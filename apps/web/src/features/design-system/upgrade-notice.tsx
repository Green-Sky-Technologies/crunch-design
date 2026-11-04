'use client';

import { useState, useTransition } from 'react';
import {
  previewDesignSystemSwitchAction,
  upgradeProjectDesignSystemAction,
} from '@/server/actions/design-systems';
import type { SystemDiff } from '@/server/services/design-systems/diff';
import { DiffView } from './diff-view';

export interface UpgradeNoticeProps {
  projectId: string;
  /** Enables "What changes?" (a diff of the pinned vs. latest version for this project). */
  designSystemId?: string;
  designSystemName: string;
  /** Version the project is pinned to. */
  version: number | null;
  latestVersion: number | null;
  upgradeAvailable: boolean;
  /** project:update */
  canUpgrade: boolean;
  /** Called after a successful upgrade (e.g. to reload the editor's design system). */
  onUpgraded?: (version: number | null) => void;
  compact?: boolean;
}

/**
 * Story 4.2 upgrade prompt: shown when a newer version of the project's design system has been
 * published. Mount it in the editor shell with the fields of `ResolvedDesignSystem`
 * (resolveProjectDesignSystem); it's also used in the design-systems project list.
 */
export function DesignSystemUpgradeNotice({
  projectId,
  designSystemId,
  designSystemName,
  version,
  latestVersion,
  upgradeAvailable,
  canUpgrade,
  onUpgraded,
  compact,
}: UpgradeNoticeProps) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [diff, setDiff] = useState<SystemDiff | null>(null);
  if (!upgradeAvailable || done) return null;

  const upgrade = () =>
    start(async () => {
      const res = await upgradeProjectDesignSystemAction(projectId);
      if (!res.ok) return setError(res.error);
      setDone(true);
      onUpgraded?.(res.data.version);
    });

  const review = () =>
    start(async () => {
      if (diff) return setDiff(null);
      const res = await previewDesignSystemSwitchAction(projectId, {
        designSystemId: designSystemId!,
      });
      if (!res.ok) return setError(res.error);
      setDiff(res.data.diff);
    });

  return (
    <div role="status" className={`text-sm ${compact ? '' : 'card border-accent/40 px-3 py-2'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span>
          {compact ? '' : `${designSystemName} `}
          <strong>v{latestVersion}</strong> is available
          {version !== null ? ` (this project uses v${version})` : ''}.
        </span>
        {designSystemId && (
          <button
            type="button"
            className="btn-ghost py-1 text-xs"
            disabled={pending}
            onClick={review}
          >
            {diff ? 'Hide changes' : 'What changes?'}
          </button>
        )}
        {canUpgrade && (
          <button
            type="button"
            className="btn-ghost py-1 text-xs"
            disabled={pending}
            onClick={upgrade}
          >
            {pending ? 'Working…' : `Upgrade to v${latestVersion}`}
          </button>
        )}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
      {diff && (
        <div className="mt-2 rounded-md bg-surface-2 p-3 text-left">
          <DiffView diff={diff} />
        </div>
      )}
    </div>
  );
}
