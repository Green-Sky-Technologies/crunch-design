import { can } from '@crunch/authz';
import { DesignSystemsPage } from '@/features/design-system';
import { requireActor } from '@/server/context';

export const metadata = { title: 'Design systems' };

/** Owned by stream-design-system (Epic 4). */
export default async function Page({ params }: PageProps<'/w/[slug]/design-systems'>) {
  const actor = await requireActor((await params).slug);
  return (
    <DesignSystemsPage
      workspaceSlug={actor.workspace.slug}
      canEdit={can(actor.role, 'design_system:edit')}
    />
  );
}
