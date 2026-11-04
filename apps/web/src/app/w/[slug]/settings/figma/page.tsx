import { requireActor } from '@/server/context';

export const metadata = { title: 'Figma' };

/** STUB: owned by stream-figma (Story 8.1 plugin tokens, Figma connection). */
export default async function Page({ params }: PageProps<'/w/[slug]/settings/figma'>) {
  await requireActor((await params).slug);
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Figma</h1>
      <p className="mt-2 text-sm text-muted">Connect the CrunchDesign Figma plugin (Epic 8).</p>
    </main>
  );
}
