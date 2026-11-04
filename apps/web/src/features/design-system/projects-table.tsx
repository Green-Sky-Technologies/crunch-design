'use client';

import Link from 'next/link';
import { Fragment, useState } from 'react';
import type { ProjectDesignSystemStatus } from '@/server/services/project-design-system';
import { SwitchPanel, type SystemOption } from './switch-panel';
import { DesignSystemUpgradeNotice } from './upgrade-notice';

function versionLabel(p: ProjectDesignSystemStatus): string {
  if (p.version === null) return 'Draft (never published)';
  return p.pinned ? `v${p.version}` : `Latest (v${p.version})`;
}

/**
 * Which system and version each project renders with, the upgrade prompt (Story 4.2) and
 * switching systems with a preview of what changes (Story 4.3).
 */
export function ProjectsTable({
  workspaceSlug,
  projects,
  systems,
  canUpdate,
}: {
  workspaceSlug: string;
  projects: ProjectDesignSystemStatus[];
  systems: SystemOption[];
  canUpdate: boolean;
}) {
  const [switching, setSwitching] = useState<string | null>(null);
  if (!projects.length) return <p className="text-sm text-muted">No projects yet.</p>;
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Project</th>
            <th className="px-3 py-2 font-medium">Design system</th>
            <th className="px-3 py-2 font-medium">Version</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {projects.map((p) => (
            <Fragment key={p.projectId}>
              <tr>
                <td className="px-3 py-2">
                  <Link href={`/w/${workspaceSlug}/p/${p.projectId}`} className="hover:underline">
                    {p.projectName}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <Link
                    href={`/w/${workspaceSlug}/design-systems/${p.designSystemId}`}
                    className="hover:underline"
                  >
                    {p.designSystemName}
                  </Link>
                </td>
                <td className="px-3 py-2 text-muted">{versionLabel(p)}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <DesignSystemUpgradeNotice
                      compact
                      projectId={p.projectId}
                      designSystemId={p.designSystemId}
                      designSystemName={p.designSystemName}
                      version={p.version}
                      latestVersion={p.latestVersion}
                      upgradeAvailable={p.upgradeAvailable}
                      canUpgrade={canUpdate}
                    />
                    {canUpdate && switching !== p.projectId && (
                      <button
                        type="button"
                        className="btn-ghost py-1 text-xs"
                        onClick={() => setSwitching(p.projectId)}
                      >
                        Change system…
                      </button>
                    )}
                  </div>
                </td>
              </tr>
              {switching === p.projectId && (
                <tr>
                  <td colSpan={4} className="px-3 pb-3">
                    <SwitchPanel
                      projectId={p.projectId}
                      currentSystemId={p.designSystemId}
                      currentVersion={p.version}
                      systems={systems}
                      onDone={() => setSwitching(null)}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
