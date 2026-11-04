/**
 * Design systems (Epic 4). `DesignSystemsPage` is the server component rendered by
 * /w/[slug]/design-systems (export name and props are part of the shell contract).
 */
import { can } from '@crunch/authz';
import Link from 'next/link';
import { db, requireActor } from '@/server/context';
import { listDesignSystems } from '@/server/services/design-systems';
import { listProjectDesignSystems } from '@/server/services/project-design-system';
import { ProjectsTable } from './projects-table';
import { NewDesignSystemForm, SystemCardActions } from './system-actions';

export { DesignSystemEditor } from './editor/design-system-editor';
export { DesignSystemUpgradeNotice, type UpgradeNoticeProps } from './upgrade-notice';

export async function DesignSystemsPage({
  workspaceSlug,
  canEdit,
}: {
  workspaceSlug: string;
  canEdit: boolean;
}) {
  const actor = await requireActor(workspaceSlug);
  const [systems, projects] = await Promise.all([
    listDesignSystems(db(), actor),
    listProjectDesignSystems(db(), actor),
  ]);
  const base = `/w/${workspaceSlug}/design-systems`;
  const options = systems.map((s) => ({ id: s.id, name: s.name, latestVersion: s.latestVersion }));

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Design systems</h1>
          <p className="mt-1 text-sm text-muted">
            Tokens, components and guidelines. Projects render with a published version.
          </p>
        </div>
        {canEdit && <NewDesignSystemForm workspaceSlug={workspaceSlug} systems={options} />}
      </div>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {systems.map((s) => (
          <li key={s.id} className="card">
            <Link href={`${base}/${s.id}`} className="block rounded-t-lg p-4 hover:bg-surface-2">
              <div className="flex items-center justify-between gap-3">
                <p className="font-medium">{s.name}</p>
                {s.isDefault && (
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted">
                    Default
                  </span>
                )}
              </div>
              {s.description && <p className="mt-1 text-sm text-muted">{s.description}</p>}
              <p className="mt-2 text-xs text-muted">
                {s.latestVersion === null ? 'Not published' : `v${s.latestVersion}`}
                {s.latestVersion !== null && s.hasUnpublishedChanges ? ' · draft changes' : ''}
                {` · ${s.projectCount} project${s.projectCount === 1 ? '' : 's'}`}
              </p>
            </Link>
            {canEdit && (
              <SystemCardActions id={s.id} isDefault={s.isDefault} projectCount={s.projectCount} />
            )}
          </li>
        ))}
      </ul>

      <section className="mt-10">
        <h2 className="mb-1 text-lg font-semibold tracking-tight">Projects</h2>
        <p className="mb-3 text-sm text-muted">
          Each project pins a published version. Editing a draft never changes them; upgrade or
          switch systems when you&apos;re ready, after previewing what changes.
        </p>
        <ProjectsTable
          workspaceSlug={workspaceSlug}
          projects={projects}
          systems={options}
          canUpdate={can(actor.role, 'project:update')}
        />
      </section>
    </main>
  );
}
