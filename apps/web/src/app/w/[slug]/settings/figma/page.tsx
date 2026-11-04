import { can } from '@crunch/authz';
import { db, requireActor } from '@/server/context';
import { getFigmaCredential } from '@/server/services/figma/credentials';
import { listPluginTokens } from '@/server/services/plugin-tokens';
import { listProjects } from '@/server/services/projects';
import { FigmaImport, FigmaToken } from './_components/figma-import';
import { PluginTokens } from './_components/plugin-tokens';

export const metadata = { title: 'Figma' };

/** Figma integration settings (Epic 8): plugin tokens, Figma REST token, import from a link. */
export default async function FigmaSettingsPage({ params }: PageProps<'/w/[slug]/settings/figma'>) {
  const actor = await requireActor((await params).slug);
  const [tokens, figmaCred, projects] = await Promise.all([
    listPluginTokens(db(), actor),
    getFigmaCredential(db(), actor),
    listProjects(db(), actor),
  ]);

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
        <FigmaToken initial={figmaCred} />
        <FigmaImport
          projects={projects.map((p) => ({ id: p.id, name: p.name }))}
          slug={actor.workspace.slug}
          canEdit={can(actor.role, 'design:edit')}
          hasToken={!!figmaCred}
        />
      </div>
    </main>
  );
}
