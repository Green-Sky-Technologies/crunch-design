import { requireActor } from '@/server/context';

/** Workspace guard. The app header lives in (app)/layout.tsx; the editor (p/) is full-screen. */
export default async function WorkspaceLayout({ children, params }: LayoutProps<'/w/[slug]'>) {
  const { slug } = await params;
  await requireActor(slug);
  return <div className="flex min-h-full flex-1 flex-col">{children}</div>;
}
