import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db, requireActor } from '@/server/context';
import { getProject } from '@/server/services/projects';
import { NotFoundError } from '@/server/services/types';

export default async function ProjectPage({ params }: PageProps<'/w/[slug]/p/[projectId]'>) {
  const { slug, projectId } = await params;
  const actor = await requireActor(slug);
  const project = await getProject(db(), actor, projectId).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });

  // Placeholder shell: Epic 3 replaces this with chat · canvas · inspector.
  return (
    <div className="grid flex-1 grid-cols-[320px_1fr_280px]">
      <aside className="border-r border-border bg-surface p-4">
        <Link href={`/w/${actor.workspace.slug}`} className="text-sm text-muted hover:text-text">
          ← Projects
        </Link>
        <h1 className="mt-3 text-lg font-semibold">{project.name}</h1>
        {project.description && <p className="mt-1 text-sm text-muted">{project.description}</p>}
        <p className="mt-8 text-sm text-muted">The agent conversation will appear here (Epic 5).</p>
      </aside>
      <section className="flex items-center justify-center bg-surface-2 text-sm text-muted">
        Canvas (Epic 3)
      </section>
      <aside className="border-l border-border bg-surface p-4 text-sm text-muted">
        Inspector (Epic 3)
      </aside>
    </div>
  );
}
