'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function WorkspaceNav({
  base,
  items,
}: {
  base: string;
  items: { href: string; label: string }[];
}) {
  const pathname = usePathname();
  return (
    <nav className="flex gap-1 text-sm">
      {items.map((item) => {
        const href = base + item.href;
        const active =
          item.href === ''
            ? pathname === base || pathname.startsWith(`${base}/p/`)
            : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`rounded-md px-2.5 py-1.5 ${active ? 'bg-surface-2 font-medium' : 'text-muted hover:text-text'}`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
