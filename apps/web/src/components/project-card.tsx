'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import {
  duplicateProjectAction,
  renameProjectAction,
  setArchivedAction,
} from '@/server/actions/projects';

interface Props {
  href: string;
  project: {
    id: string;
    name: string;
    thumbnailUrl: string | null;
    updatedAt: string;
    archived: boolean;
  };
  canManage: boolean;
  canDuplicate: boolean;
}

export function ProjectCard({ href, project, canManage, canDuplicate }: Props) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setMenu(false);
      const res = await fn();
      setError(res.ok ? null : (res.error ?? 'Failed'));
    });

  return (
    <div className={`card group relative overflow-hidden ${pending ? 'opacity-60' : ''}`}>
      <Link
        href={href}
        className="block aspect-[16/10] bg-surface-2"
        aria-label={`Open ${project.name}`}
      >
        {project.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={project.thumbnailUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="grid w-1/2 gap-2 opacity-40">
              <div className="h-3 rounded bg-border" />
              <div className="h-8 rounded bg-border" />
              <div className="grid grid-cols-3 gap-2">
                <div className="h-6 rounded bg-border" />
                <div className="h-6 rounded bg-border" />
                <div className="h-6 rounded bg-border" />
              </div>
            </div>
          </div>
        )}
      </Link>
      <div className="flex items-start justify-between gap-2 p-3">
        {editing ? (
          <form
            className="flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              setEditing(false);
              if (name.trim() && name !== project.name)
                act(() => renameProjectAction(project.id, name));
            }}
          >
            <input
              className="input py-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              onBlur={(e) => e.currentTarget.form?.requestSubmit()}
              maxLength={120}
              aria-label="Project name"
            />
          </form>
        ) : (
          <div className="min-w-0">
            <Link href={href} className="block truncate font-medium hover:underline">
              {project.name}
            </Link>
            <p className="text-xs text-muted">
              Edited {new Date(project.updatedAt).toLocaleDateString()}
            </p>
          </div>
        )}
        {(canManage || canDuplicate) && (
          <div className="relative">
            <button
              className="btn-ghost px-2 py-1"
              aria-label="Project actions"
              aria-expanded={menu}
              onClick={() => setMenu((m) => !m)}
            >
              ⋯
            </button>
            {menu && (
              <div
                className="card absolute right-0 z-10 mt-1 w-40 overflow-hidden py-1 text-sm shadow-lg"
                role="menu"
              >
                {canManage && !project.archived && (
                  <MenuItem
                    onClick={() => {
                      setMenu(false);
                      setEditing(true);
                    }}
                  >
                    Rename
                  </MenuItem>
                )}
                {canDuplicate && !project.archived && (
                  <MenuItem onClick={() => act(() => duplicateProjectAction(project.id))}>
                    Duplicate
                  </MenuItem>
                )}
                {canManage && (
                  <MenuItem
                    onClick={() => act(() => setArchivedAction(project.id, !project.archived))}
                  >
                    {project.archived ? 'Restore' : 'Archive'}
                  </MenuItem>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {error && <p className="px-3 pb-3 text-xs text-danger">{error}</p>}
    </div>
  );
}

function MenuItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      role="menuitem"
      className="block w-full px-3 py-1.5 text-left hover:bg-surface-2"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
