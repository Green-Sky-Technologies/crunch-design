// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasPane, EditLockIndicator } from './index';
import { setLockApi, type LockApi, type LockState } from './lock';
import { grantingLockApi, renderEditor } from './test-utils';

const me = { userId: 'user_1', name: 'Me Myself', imageUrl: null };
const bob = { userId: 'user_bob', name: 'Bob Builder', imageUrl: null };

function lockState(
  holder: typeof me | null,
  extra: Partial<NonNullable<LockState['lock']>> = {},
  canTakeOver = false,
): LockState {
  return {
    lock: holder
      ? {
          holder,
          isMine: holder.userId === me.userId,
          isThisSession: holder.userId === me.userId,
          acquiredAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          requestedBy: null,
          ...extra,
        }
      : null,
    presence: [
      { ...me, isMe: true },
      { ...bob, isMe: false },
    ],
    canTakeOver,
    ttlMs: 120_000,
  };
}

/** A scriptable lock server. */
function fakeApi(initial: { holder: typeof me | null; canTakeOver?: boolean }) {
  let holder = initial.holder;
  let requestedBy: typeof me | null = null;
  const st = () =>
    lockState(holder, { requestedBy }, !!initial.canTakeOver && holder?.userId !== me.userId);
  const api: LockApi = {
    acquire: vi.fn(async () => {
      const acquired = !holder || holder.userId === me.userId;
      if (acquired) holder = me;
      return { acquired, state: st() };
    }),
    heartbeat: vi.fn(async () => st()),
    release: vi.fn(async (_p, _s, opts) => {
      if (holder?.userId === me.userId) holder = opts?.handoff && requestedBy ? requestedBy : null;
      requestedBy = null;
      return st();
    }),
    request: vi.fn(async () => {
      requestedBy = me;
      return st();
    }),
    decline: vi.fn(async () => {
      requestedBy = null;
      return st();
    }),
    takeOver: vi.fn(async () => {
      holder = me;
      return st();
    }),
  };
  return {
    api,
    set: (h: typeof me | null, req: typeof me | null = null) => {
      holder = h;
      requestedBy = req;
    },
  };
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setLockApi(grantingLockApi);
});

const flush = () => act(async () => {});

function setup(server: ReturnType<typeof fakeApi>, role: 'editor' | 'viewer' | 'admin' = 'editor') {
  setLockApi(server.api);
  return renderEditor(
    <>
      <EditLockIndicator />
      <CanvasPane />
    </>,
    { role, userId: me.userId },
  );
}

describe('edit lock UI (Story 3.8)', () => {
  it('acquires a free lock on open and stays editable, with presence avatars', async () => {
    const server = fakeApi({ holder: null });
    const { store } = setup(server);
    await flush();
    expect(server.api.acquire).toHaveBeenCalledTimes(1);
    expect(store().getState().readOnly).toBe(false);
    expect(screen.getByText('Editing')).toBeTruthy();
    expect(screen.getAllByRole('listitem').map((l) => l.textContent)).toEqual(['MM', 'BB']);
  });

  it('is read-only while someone else holds the lock; request control asks the holder', async () => {
    const server = fakeApi({ holder: bob });
    const { store } = setup(server);
    await flush();
    expect(store().getState()).toMatchObject({ readOnly: true, readOnlyReason: 'locked' });
    expect(screen.getByText('Bob Builder is editing')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '+ Frame' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Request control' }));
    await flush();
    expect(server.api.request).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Control requested' })).toBeTruthy();
    // non-admins can't take over
    expect(screen.queryByRole('button', { name: 'Take over' })).toBeNull();
  });

  it('becomes editable again once the lock frees up (holder left or the lock expired)', async () => {
    const server = fakeApi({ holder: bob });
    const { store } = setup(server);
    await flush();
    expect(store().getState().readOnly).toBe(true);
    server.set(null); // bob's tab died; after the 2-minute TTL the server reports no lock
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(server.api.acquire).toHaveBeenCalledTimes(2);
    expect(store().getState().readOnly).toBe(false);
  });

  it('loses edit rights when an admin takes over', async () => {
    const server = fakeApi({ holder: null });
    const { store } = setup(server);
    await flush();
    expect(store().getState().readOnly).toBe(false);
    server.set(bob);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_100);
    });
    expect(store().getState()).toMatchObject({ readOnly: true, readOnlyReason: 'locked' });
  });

  it('admins can take over', async () => {
    const server = fakeApi({ holder: bob, canTakeOver: true });
    const { store } = setup(server, 'admin');
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await flush();
    expect(server.api.takeOver).toHaveBeenCalled();
    expect(store().getState().readOnly).toBe(false);
  });

  it('the holder is prompted on a request and can hand over or keep editing', async () => {
    const server = fakeApi({ holder: null });
    const { store } = setup(server);
    await flush();
    server.set(me, bob);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_100);
    });
    const dialog = screen.getByRole('alertdialog', { name: 'Control requested' });
    expect(dialog.textContent).toContain('Bob Builder wants to edit');
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await flush();
    expect(server.api.decline).toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();

    server.set(me, bob);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_100);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Hand over' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000); // past the other-tab freeze wait
    });
    expect(server.api.release).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      handoff: true,
    });
    expect(store().getState()).toMatchObject({ readOnly: true, readOnlyReason: 'locked' });
  });

  it('another tab of the same user handing over makes this tab flush and go read-only', async () => {
    const server = fakeApi({ holder: null });
    const { store } = setup(server);
    await flush();
    expect(store().getState().readOnly).toBe(false);
    const other = new BroadcastChannel('cd-lock:00000000-0000-4000-8000-000000000001');
    const acks: unknown[] = [];
    other.onmessage = (e) => acks.push(e.data);
    other.postMessage({ type: 'freeze', from: 'other-tab-session' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(store().getState()).toMatchObject({ readOnly: true, readOnlyReason: 'locked' });
    expect(acks).toEqual([{ type: 'frozen', to: 'other-tab-session' }]);
    other.close();
  });

  it('viewers only heartbeat presence and see View only', async () => {
    const server = fakeApi({ holder: bob });
    setup(server, 'viewer');
    await flush();
    expect(server.api.acquire).not.toHaveBeenCalled();
    expect(server.api.heartbeat).toHaveBeenCalled();
    expect(screen.getByText('View only')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request control' })).toBeNull();
  });

  it('releases the lock when the editor closes', async () => {
    const server = fakeApi({ holder: null });
    const { unmount } = setup(server);
    await flush();
    unmount();
    expect(server.api.release).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      leave: true,
      keepalive: true,
    });
  });
});
