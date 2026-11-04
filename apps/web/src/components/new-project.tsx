'use client';

import { useActionState, useState } from 'react';
import { createProjectAction } from '@/server/actions/projects';

export function NewProjectButton() {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(createProjectAction, null);
  return (
    <>
      <button className="btn-primary" onClick={() => setOpen(true)}>
        New project
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => e.target === e.currentTarget && setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-project-title"
        >
          <form action={action} className="card w-full max-w-md p-6 text-left shadow-xl">
            <h2 id="new-project-title" className="mb-4 text-lg font-semibold">
              New project
            </h2>
            <label className="label" htmlFor="np-name">
              Name
            </label>
            <input
              id="np-name"
              name="name"
              className="input"
              autoFocus
              required
              maxLength={120}
              placeholder="Pricing page"
            />
            {state && !state.ok && state.fieldErrors?.name && (
              <p className="mt-1 text-sm text-danger">{state.fieldErrors.name[0]}</p>
            )}
            <label className="label mt-4" htmlFor="np-desc">
              Description <span className="text-muted">(optional)</span>
            </label>
            <textarea id="np-desc" name="description" className="input min-h-20" maxLength={1000} />
            {state && !state.ok && !state.fieldErrors && (
              <p className="mt-3 text-sm text-danger">{state.error}</p>
            )}
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={pending}>
                {pending ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
