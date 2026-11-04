import { can } from '@crunch/authz';
import { redirect } from 'next/navigation';
import { requireActor } from '@/server/context';

export const metadata = { title: 'Usage' };

/** STUB: owned by stream-agent (Story 5.10 usage dashboard). Admins only. */
export default async function Page({ params }: PageProps<'/w/[slug]/settings/usage'>) {
  const actor = await requireActor((await params).slug);
  if (!can(actor.role, 'workspace:manage_credentials')) redirect(`/w/${actor.workspace.slug}`);
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Usage</h1>
      <p className="mt-2 text-sm text-muted">Model usage and estimated cost per member (Epic 5).</p>
    </main>
  );
}
