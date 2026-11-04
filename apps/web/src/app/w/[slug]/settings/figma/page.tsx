import { db, requireActor } from '@/server/context';
import { listPluginTokens } from '@/server/services/plugin-tokens';
import { PluginTokens } from './_components/plugin-tokens';

export const metadata = { title: 'Figma' };

/** Figma integration settings (Epic 8): plugin tokens. */
export default async function FigmaSettingsPage({ params }: PageProps<'/w/[slug]/settings/figma'>) {
  const actor = await requireActor((await params).slug);
  const tokens = await listPluginTokens(db(), actor);

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-8">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Figma</h1>
      <p className="mb-6 text-sm text-muted">
        Push designs into Figma, import Figma frames, and sync design tokens with Figma variables
        through the CrunchDesign Figma plugin. There&apos;s no live two-way sync: each push, import
        or token sync is an explicit, one-shot action.
      </p>
      <div className="flex flex-col gap-6">
        <PluginTokens initial={tokens} currentUserId={actor.userId} />
      </div>
    </main>
  );
}
