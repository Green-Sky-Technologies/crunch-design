import { OrganizationSwitcher, UserButton } from '@clerk/nextjs';
import { can } from '@crunch/authz';
import Link from 'next/link';
import { Logo } from '@/components/logo';
import { WorkspaceNav } from '@/components/workspace-nav';
import { requireActor } from '@/server/context';

export default async function WorkspaceLayout({ children, params }: LayoutProps<'/w/[slug]'>) {
  const { slug } = await params;
  const actor = await requireActor(slug);
  const base = `/w/${actor.workspace.slug}`;

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex h-14 items-center gap-4 border-b border-border bg-surface px-4">
        <Link href={base} aria-label="Projects">
          <Logo compact />
        </Link>
        <OrganizationSwitcher
          hidePersonal
          afterSelectOrganizationUrl="/w/:slug"
          afterCreateOrganizationUrl="/w/:slug"
          afterLeaveOrganizationUrl="/"
        />
        <WorkspaceNav
          base={base}
          items={[
            { href: '', label: 'Projects' },
            { href: '/design-systems', label: 'Design systems' },
            { href: '/settings/members', label: 'Members' },
            ...(can(actor.role, 'design:edit')
              ? [{ href: '/settings/figma', label: 'Figma' }]
              : []),
            ...(can(actor.role, 'workspace:manage_credentials')
              ? [
                  { href: '/settings/credentials', label: 'Model access' },
                  { href: '/settings/usage', label: 'Usage' },
                ]
              : []),
          ]}
        />
        <span className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 font-mono text-xs capitalize text-muted">
          {actor.role}
        </span>
        <UserButton />
      </header>
      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  );
}
