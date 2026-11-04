import { can } from '@crunch/authz';
import { redirect } from 'next/navigation';
import { db, requireActor } from '@/server/context';
import { getAgentSettings } from '@/server/services/agent/model-settings';
import { ModelSettingsForm } from './model-settings-form';

export const metadata = { title: 'Usage' };

/** Usage and model settings (Stories 5.9, 5.10). Admins only. */
export default async function Page({ params }: PageProps<'/w/[slug]/settings/usage'>) {
  const actor = await requireActor((await params).slug);
  if (!can(actor.role, 'workspace:manage_credentials')) redirect(`/w/${actor.workspace.slug}`);
  const settings = await getAgentSettings(db(), actor);
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Usage</h1>
      <p className="mt-2 text-sm text-muted">Model usage and estimated cost per member.</p>
      <section className="mt-8">
        <h2 className="text-lg font-semibold">Models</h2>
        <p className="mt-1 text-sm text-muted">
          Defaults by task and the models members may choose. Every call uses the workspace
          credential.
        </p>
        <ModelSettingsForm initial={settings} />
      </section>
    </main>
  );
}
