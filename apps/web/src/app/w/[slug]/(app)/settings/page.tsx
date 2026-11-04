import { redirect } from 'next/navigation';
import { requireActor } from '@/server/context';

export default async function SettingsIndex({ params }: PageProps<'/w/[slug]/settings'>) {
  const actor = await requireActor((await params).slug);
  redirect(`/w/${actor.workspace.slug}/settings/members`);
}
