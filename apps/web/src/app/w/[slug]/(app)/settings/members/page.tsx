import { OrganizationProfile } from '@clerk/nextjs';
import { requireActor } from '@/server/context';

export const metadata = { title: 'Members' };

export default async function MembersPage({ params }: PageProps<'/w/[slug]/settings/members'>) {
  await requireActor((await params).slug);
  return (
    <main className="w-full max-w-5xl">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Members</h1>
      <p className="mb-6 text-sm text-muted">
        Admins manage members and model access · Editors design and run the agent · Viewers can view
        and export.
      </p>
      <OrganizationProfile routing="hash" />
    </main>
  );
}
