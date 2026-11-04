import { can } from '@crunch/authz';
import { SettingsNav } from '@/components/settings-nav';
import { requireActor } from '@/server/context';

/** Workspace settings: one place for members, integrations and model access (admin-only items hidden). */
export default async function SettingsLayout({
  children,
  params,
}: LayoutProps<'/w/[slug]/settings'>) {
  const actor = await requireActor((await params).slug);
  const items = [
    { href: '/members', label: 'Members' },
    ...(can(actor.role, 'design:edit') ? [{ href: '/figma', label: 'Figma' }] : []),
    ...(can(actor.role, 'workspace:manage_credentials')
      ? [
          { href: '/credentials', label: 'Model access' },
          { href: '/usage', label: 'Usage' },
        ]
      : []),
  ];
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8 md:flex-row md:gap-10">
      <aside className="md:w-44 md:shrink-0">
        <p className="mb-2 px-2.5 text-xs font-medium uppercase tracking-wide text-muted">
          Settings
        </p>
        <SettingsNav base={`/w/${actor.workspace.slug}`} items={items} />
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
