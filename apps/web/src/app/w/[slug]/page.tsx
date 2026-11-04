import { can } from '@crunch/authz';
import Link from 'next/link';
import { NewProjectButton } from '@/components/new-project';
import { ProjectCard } from '@/components/project-card';
import { db, requireActor } from '@/server/context';
import { hasWorkingCredential } from '@/server/services/credentials';
import { listProjects } from '@/server/services/projects';

export const metadata = { title: 'Projects' };

export default async function ProjectsPage({ params, searchParams }: PageProps<'/w/[slug]'>) {
  const { slug } = await params;
  const archived = (await searchParams).archived === '1';
  const actor = await requireActor(slug);
  const [items, hasKey] = await Promise.all([
    listProjects(db(), actor, { archived }),
    hasWorkingCredential(db(), actor.workspace.id),
  ]);
  const canCreate = can(actor.role, 'project:create');
  const canManage = can(actor.role, 'project:update');
  const base = `/w/${actor.workspace.slug}`;

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-8">
      {!hasKey && (
        <div className="card mb-6 flex items-center justify-between gap-4 border-accent/40 p-4 text-sm">
          <p>
            <strong>Connect a model to use the agent.</strong>{' '}
            <span className="text-muted">You can still create and edit designs by hand.</span>
          </p>
          {can(actor.role, 'workspace:manage_credentials') ? (
            <Link href={`${base}/settings/credentials`} className="btn-primary shrink-0">
              Add credential
            </Link>
          ) : (
            <span className="shrink-0 text-muted">Ask a workspace admin to add one.</span>
          )}
        </div>
      )}

      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {archived ? 'Archived projects' : 'Projects'}
          </h1>
          <p className="text-sm text-muted">{actor.workspace.name}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={archived ? base : `${base}?archived=1`} className="btn-ghost">
            {archived ? 'Back to projects' : 'Archived'}
          </Link>
          {canCreate && !archived && <NewProjectButton />}
        </div>
      </div>

      {items.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 px-6 py-20 text-center">
          <p className="font-medium">{archived ? 'Nothing archived.' : 'No projects yet.'}</p>
          {!archived && (
            <p className="max-w-sm text-sm text-muted">
              {canCreate
                ? 'Create a project, then describe what you want and the agent will design it.'
                : 'Projects your team creates will appear here.'}
            </p>
          )}
          {canCreate && !archived && <NewProjectButton />}
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((p) => (
            <li key={p.id}>
              <ProjectCard
                href={`${base}/p/${p.id}`}
                project={{
                  id: p.id,
                  name: p.name,
                  thumbnailUrl: p.thumbnailUrl,
                  updatedAt: p.updatedAt.toISOString(),
                  archived: !!p.archivedAt,
                }}
                canManage={canManage}
                canDuplicate={canCreate}
              />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
