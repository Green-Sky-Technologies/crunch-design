'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Vertical section nav for /w/[slug]/settings/*. Items are pre-filtered by role on the server. */
export function SettingsNav({
  base,
  items,
}: {
  base: string;
  items: { href: string; label: string }[];
}) {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="flex gap-1 text-sm md:flex-col">
      {items.map((item) => {
        const href = `${base}/settings${item.href}`;
        const active = pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-md px-2.5 py-1.5 ${active ? 'bg-surface-2 font-medium text-text' : 'text-muted hover:bg-surface-2 hover:text-text'}`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
