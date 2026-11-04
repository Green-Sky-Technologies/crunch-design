'use client';

/** Right-hand drawer that hosts the collab panels, below the editor top bar (h-11). */
import type { ReactNode } from 'react';
import { useCollab } from './store';

export function Drawer({ title, children }: { title: string; children: ReactNode }) {
  const setPanel = useCollab((s) => s.setPanel);
  return (
    <aside
      role="dialog"
      aria-label={title}
      className="fixed bottom-0 right-0 top-11 z-40 flex w-[380px] max-w-full flex-col border-l border-border bg-surface text-sm shadow-xl"
    >
      <div className="flex h-10 shrink-0 items-center border-b border-border px-3">
        <h2 className="font-medium">{title}</h2>
        <button
          className="ml-auto text-muted hover:text-text"
          onClick={() => setPanel(null)}
          aria-label={`Close ${title}`}
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </aside>
  );
}
