import { can } from '@crunch/authz';
import { notFound } from 'next/navigation';
import { DesignSystemEditor } from '@/features/design-system';
import { db, requireActor } from '@/server/context';
import { getDesignSystem } from '@/server/services/design-systems';
import { NotFoundError } from '@/server/services/types';

/** Design-system editor (Story 4.1). Owned by stream-design-system. */
export default async function Page({ params }: PageProps<'/w/[slug]/design-systems/[dsId]'>) {
  const { slug, dsId } = await params;
  const actor = await requireActor(slug);
  const detail = await getDesignSystem(db(), actor, dsId).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const { system } = detail;
  return (
    <DesignSystemEditor
      workspaceSlug={actor.workspace.slug}
      system={{
        id: system.id,
        name: system.name,
        description: system.description,
        isDefault: system.isDefault,
        latestVersion: system.latestVersion,
        revision: system.revision,
      }}
      initialDraft={detail.draft}
      canEdit={can(actor.role, 'design_system:edit')}
    />
  );
}

export async function generateMetadata({ params }: PageProps<'/w/[slug]/design-systems/[dsId]'>) {
  const { slug, dsId } = await params;
  const actor = await requireActor(slug);
  const detail = await getDesignSystem(db(), actor, dsId).catch(() => null);
  return { title: detail?.system.name ?? 'Design system' };
}
