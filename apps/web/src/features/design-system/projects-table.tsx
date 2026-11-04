'use client';

import Link from 'next/link';
import type { ProjectDesignSystemStatus } from '@/server/services/project-design-system';
import { DesignSystemUpgradeNotice } from './upgrade-notice';

function versionLabel(p: ProjectDesignSystemStatus): string {
  if (p.version === null) return 'Draft (never published)';
  return p.pinned ? `v${p.version}` : `Latest (v${p.version})`;
}

/** Which system and version each project renders with, plus the upgrade prompt (Story 4.2). */
export function ProjectsTable({
  workspaceSlug,
  projects,
  canUpdate,
}: {
  workspaceSlug: string;
  projects: ProjectDesignSystemStatus[];
  canUpdate: boolean;
}) {
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
            <tr key={p.projectId}>
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
                <DesignSystemUpgradeNotice
                  compact
                  projectId={p.projectId}
                  designSystemName={p.designSystemName}
                  version={p.version}
                  latestVersion={p.latestVersion}
                  upgradeAvailable={p.upgradeAvailable}
                  canUpgrade={canUpdate}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
