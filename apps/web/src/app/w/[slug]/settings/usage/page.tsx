import { can } from '@crunch/authz';
import { redirect } from 'next/navigation';
import { db, requireActor } from '@/server/context';
import { getAgentSettings } from '@/server/services/agent/model-settings';
import { usageSummary } from '@/server/services/usage';
import { ModelSettingsForm } from './model-settings-form';
import { UsageDashboard } from './usage-dashboard';

export const metadata = { title: 'Usage' };

/** Usage dashboard and model settings (Stories 5.9, 5.10). Admins only. */
export default async function Page({
  params,
  searchParams,
}: PageProps<'/w/[slug]/settings/usage'>) {
  const actor = await requireActor((await params).slug);
  if (!can(actor.role, 'workspace:manage_credentials')) redirect(`/w/${actor.workspace.slug}`);
  const sp = await searchParams;
  const days = Number(Array.isArray(sp.days) ? sp.days[0] : sp.days) || 30;
  const [settings, summary] = await Promise.all([
    getAgentSettings(db(), actor),
    usageSummary(db(), actor, { days }),
  ]);
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Usage</h1>
      <p className="mt-2 text-sm text-muted">Model usage and estimated cost per member.</p>
      <nav className="mt-3 flex gap-2 text-xs" aria-label="Period">
        {[7, 30, 90].map((d) => (
          <a
            key={d}
            href={`?days=${d}`}
            className={`rounded px-2 py-1 ${d === summary.days ? 'bg-surface-2 font-medium' : 'text-muted'}`}
          >
            {d} days
          </a>
        ))}
      </nav>
      <section className="mt-4">
        <UsageDashboard summary={summary} />
      </section>
      <section className="mt-12">
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
