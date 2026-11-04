import { permissionsFor } from '@crunch/authz';
import { notFound } from 'next/navigation';
import { EditorShell } from '@/components/editor/editor-shell';
import { EditorProvider } from '@/features/doc-store';
import { db, requireActor } from '@/server/context';
import { hasWorkingCredential } from '@/server/services/credentials';
import { getDoc } from '@/server/services/design-docs';
import { resolveProjectDesignSystem } from '@/server/services/project-design-system';
import { getProject } from '@/server/services/projects';
import { NotFoundError } from '@/server/services/types';

export default async function ProjectPage({ params }: PageProps<'/w/[slug]/p/[projectId]'>) {
  const { slug, projectId } = await params;
  const actor = await requireActor(slug);
  const project = await getProject(db(), actor, projectId).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const [state, ds, agentAvailable] = await Promise.all([
    getDoc(db(), actor, project.id),
    resolveProjectDesignSystem(db(), actor, project),
    hasWorkingCredential(db(), actor.workspace.id),
  ]);

  return (
    <EditorProvider
      info={{
        project: { id: project.id, name: project.name, description: project.description },
        workspace: {
          id: actor.workspace.id,
          slug: actor.workspace.slug,
          name: actor.workspace.name,
        },
        user: { id: actor.userId, role: actor.role },
        permissions: permissionsFor(actor.role),
        designSystem: ds,
        agentAvailable,
      }}
      initial={{ version: state.version, doc: state.doc }}
    >
      <EditorShell />
    </EditorProvider>
  );
}

export async function generateMetadata({ params }: PageProps<'/w/[slug]/p/[projectId]'>) {
  const { slug, projectId } = await params;
  const actor = await requireActor(slug);
  const project = await getProject(db(), actor, projectId).catch(() => null);
  return { title: project?.name ?? 'Project' };
}
