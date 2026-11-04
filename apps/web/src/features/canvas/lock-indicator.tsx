'use client';

/**
 * Top-bar edit lock indicator (Story 3.8): presence avatars, who's editing, "Request control",
 * Admin "Take over", and, for the holder, a prompt to hand over when someone asks.
 */
import { useDocStore, useEditor } from '../doc-store';
import { useEditLock, type LockState } from './lock';

type Person = NonNullable<LockState['lock']>['holder'];

const display = (p: Person | null | undefined) => p?.name ?? 'A teammate';
const initials = (p: Person) =>
  (p.name ?? p.userId)
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

function Avatars({ state }: { state: LockState }) {
  const shown = state.presence.slice(0, 4);
  const more = state.presence.length - shown.length;
  return (
    <div className="flex -space-x-1.5" aria-label="People viewing this project" role="list">
      {shown.map((p) => {
        const editing = state.lock?.holder.userId === p.userId;
        return (
          <span
            key={p.userId}
            role="listitem"
            title={`${p.isMe ? 'You' : display(p)}${editing ? ' (editing)' : ''}`}
            className={`inline-flex h-6 w-6 items-center justify-center overflow-hidden rounded-full border-2 bg-surface-2 text-[10px] font-semibold ${
              editing ? 'border-accent' : 'border-surface'
            }`}
          >
            {p.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- tiny avatar from Clerk
              <img src={p.imageUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              initials(p)
            )}
          </span>
        );
      })}
      {more > 0 && (
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border-2 border-surface bg-surface-2 text-[10px]">
          +{more}
        </span>
      )}
    </div>
  );
}

export function EditLockIndicator() {
  const { can, user, project } = useEditor();
  const readOnly = useDocStore((s) => s.readOnly);
  const reason = useDocStore((s) => s.readOnlyReason);
  const lock = useEditLock();
  const state = lock.state;
  const holder = state?.lock;
  const canEdit = can('design:edit');
  const requestedByMe = holder?.requestedBy?.userId === user.id;

  return (
    <div className="relative flex items-center gap-2 text-xs" data-testid="edit-lock">
      {state && state.presence.length > 0 && <Avatars state={state} />}
      {project.archived ? (
        <span
          className="rounded-full bg-surface-2 px-2 py-0.5 text-muted"
          title="This project is archived. Restore it from the projects page to edit it."
        >
          Archived
        </span>
      ) : !canEdit ? (
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-muted">View only</span>
      ) : readOnly && reason === 'locked' ? (
        <>
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-muted">
            {holder ? `${display(holder.holder)} is editing` : 'Someone else is editing'}
          </span>
          {holder && (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-accent hover:bg-surface-2 disabled:text-muted"
              disabled={lock.busy || !!requestedByMe}
              onClick={() => void lock.request()}
            >
              {requestedByMe ? 'Control requested' : 'Request control'}
            </button>
          )}
          {state?.canTakeOver && (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-danger hover:bg-surface-2"
              disabled={lock.busy}
              onClick={() => void lock.takeOver()}
            >
              Take over
            </button>
          )}
        </>
      ) : readOnly ? (
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-muted">View only</span>
      ) : holder?.isMine ? (
        <span className="flex items-center gap-1 text-muted" title="You hold the edit lock">
          <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden />
          Editing
        </span>
      ) : null}
      {lock.offline && (
        <span className="text-muted" title="Can't reach the server; retrying">
          · offline
        </span>
      )}
      {holder?.isMine && holder.requestedBy && (
        <div
          role="alertdialog"
          aria-label="Control requested"
          className="card absolute left-0 top-full z-50 mt-2 w-72 space-y-2 p-3 shadow-lg"
        >
          <p>
            <strong>{display(holder.requestedBy)}</strong> wants to edit this project.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-ghost px-2 py-1"
              disabled={lock.busy}
              onClick={() => void lock.decline()}
            >
              Keep editing
            </button>
            <button
              type="button"
              className="btn-primary px-2 py-1"
              disabled={lock.busy}
              onClick={() => void lock.handOver()}
            >
              Hand over
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
