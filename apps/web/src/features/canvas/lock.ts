'use client';

/**
 * Edit lock client (Story 3.8). Editors acquire the project's soft lock when the editor opens and
 * heartbeat it; while someone else holds it the doc store is read-only ('locked'). When the lock
 * frees up (holder closed the tab, released, handed over, or it expired after 2 minutes) the next
 * poll takes it, reloads the latest doc, and makes the canvas editable again. Everyone, viewers
 * included, heartbeats presence.
 */
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { LockState } from '@/server/services/locks';
import { useDocStoreApi, useEditor, type DocStore } from '../doc-store';

export type { LockState };

export const HOLDER_HEARTBEAT_MS = 20_000;
export const WAITING_POLL_MS = 5_000;

export interface LockApi {
  acquire(projectId: string, sessionId: string): Promise<{ acquired: boolean; state: LockState }>;
  heartbeat(projectId: string, sessionId: string): Promise<LockState>;
  release(
    projectId: string,
    sessionId: string,
    opts?: { handoff?: boolean; leave?: boolean; keepalive?: boolean },
  ): Promise<LockState | null>;
  request(projectId: string, sessionId: string): Promise<LockState>;
  decline(projectId: string, sessionId: string): Promise<LockState>;
  takeOver(projectId: string, sessionId: string): Promise<LockState>;
}

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`Lock request failed (${r.status})`);
  return r.json() as Promise<T>;
}
const base = (projectId: string) => `/api/projects/${projectId}/lock`;
const post = (url: string, sessionId: string, method = 'POST') =>
  fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
    cache: 'no-store',
  });

export const httpLockApi: LockApi = {
  acquire: async (p, s) => json(await post(base(p), s)),
  heartbeat: async (p, s) => json(await post(base(p), s, 'PUT')),
  async release(p, s, opts = {}) {
    const q = new URLSearchParams({ sessionId: s });
    if (opts.handoff) q.set('handoff', '1');
    if (opts.leave) q.set('leave', '1');
    const r = await fetch(`${base(p)}?${q}`, { method: 'DELETE', keepalive: !!opts.keepalive });
    return opts.keepalive ? null : json(r);
  },
  request: async (p, s) => json(await post(`${base(p)}/request`, s)),
  decline: async (p, s) =>
    json(
      await fetch(`${base(p)}/request?sessionId=${encodeURIComponent(s)}`, { method: 'DELETE' }),
    ),
  takeOver: async (p, s) => json(await post(`${base(p)}/takeover`, s)),
};

let lockApi: LockApi = httpLockApi;
/** Swap the transport (component tests, the e2e harness). */
export function setLockApi(api: LockApi) {
  lockApi = api;
}

export interface LockUiState {
  state: LockState | null;
  sessionId: string;
  offline: boolean;
  busy: boolean;
}

export interface LockController {
  store: StoreApi<LockUiState>;
  request(): Promise<void>;
  decline(): Promise<void>;
  handOver(): Promise<void>;
  takeOver(): Promise<void>;
  /**
   * Re-check the lock now (entering edit mode): takes it if it's free; if someone else holds it
   * the doc store goes read-only ('locked') and the UI shows who.
   */
  refresh(): Promise<void>;
}

const controllers = new WeakMap<DocStore, LockController>();

function sessionId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function controllerFor(docStore: DocStore, projectId: string, canEdit: boolean): LockController {
  let c = controllers.get(docStore);
  if (c) return c;
  const store = createStore<LockUiState>()(() => ({
    state: null,
    sessionId: sessionId(),
    offline: false,
    busy: false,
  }));
  const sid = () => store.getState().sessionId;

  /** Bring the doc store's read-only flag in line with the lock. */
  const sync = async (state: LockState, mayAcquire = true) => {
    store.setState({ state, offline: false });
    if (!canEdit) return;
    const s = docStore.getState();
    const lockedOut = s.readOnly && s.readOnlyReason === 'locked';
    if (state.lock?.isMine) {
      if (lockedOut) {
        await s.reload(); // pick up the previous holder's changes first
        docStore.getState().setReadOnly(false);
      }
    } else if (state.lock) {
      if (!s.readOnly) {
        if (s.queue.length) await s.flush(); // the server rejects these (423); the store reports it
        docStore.getState().setReadOnly(true, 'locked');
        await docStore.getState().reload();
      }
    } else {
      if (mayAcquire) await acquire();
    }
  };

  const acquire = async () => {
    const r = await lockApi.acquire(projectId, sid());
    // A lost race leaves state.lock held by someone else; sync makes us read-only.
    if (r.acquired || r.state.lock) await sync(r.state, false);
    else store.setState({ state: r.state });
  };

  const guard = (fn: () => Promise<void>) => async () => {
    store.setState({ busy: true });
    try {
      await fn();
    } catch {
      store.setState({ offline: true });
    } finally {
      store.setState({ busy: false });
    }
  };

  c = {
    store,
    request: guard(async () => sync(await lockApi.request(projectId, sid()))),
    decline: guard(async () => sync(await lockApi.decline(projectId, sid()))),
    handOver: guard(async () => {
      // Nothing of ours is lost in the hand-over: this tab flushes, and the user's other tabs
      // flush and go read-only before the lock moves.
      await docStore.getState().flush();
      await freezeOtherTabs(projectId, sid());
      const st = await lockApi.release(projectId, sid(), { handoff: true });
      if (st) await sync(st);
    }),
    takeOver: guard(async () => sync(await lockApi.takeOver(projectId, sid()))),
    refresh: guard(async () => {
      if (canEdit) await sync(await lockApi.heartbeat(projectId, sid()));
    }),
  };
  controllers.set(docStore, c);
  // Expose the internal steps to the hook below.
  internals.set(c, { sync, acquire });
  return c;
}

/** Same-user tab coordination for hand-over (BroadcastChannel, same origin only). */
const channelName = (projectId: string) => `cd-lock:${projectId}`;
type TabMsg = { type: 'freeze'; from: string } | { type: 'frozen'; to: string };

/** Ask this user's other tabs to flush and go read-only; resolves once they ack (or 800ms pass). */
export async function freezeOtherTabs(projectId: string, sessionId: string): Promise<void> {
  if (typeof BroadcastChannel === 'undefined') return;
  const ch = new BroadcastChannel(channelName(projectId));
  await new Promise<void>((resolve) => {
    let quiet: ReturnType<typeof setTimeout> = setTimeout(resolve, 800);
    ch.onmessage = (e: MessageEvent<TabMsg>) => {
      if (e.data.type === 'frozen' && e.data.to === sessionId) {
        clearTimeout(quiet);
        quiet = setTimeout(resolve, 100); // give any other tabs a moment to ack too
      }
    };
    ch.postMessage({ type: 'freeze', from: sessionId } satisfies TabMsg);
  });
  ch.close();
}

const internals = new WeakMap<
  LockController,
  { sync(state: LockState): Promise<void>; acquire(): Promise<void> }
>();

/** Runs the lock/presence loop for the editor. Mount once (the canvas pane does). */
export function useEditLockLoop() {
  const docStore = useDocStoreApi();
  const { project, can } = useEditor();
  const canEdit = can('design:edit');
  const [c] = useState(() => controllerFor(docStore, project.id, canEdit));

  useEffect(() => {
    const { sync, acquire } = internals.get(c)!;
    const sid = c.store.getState().sessionId;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const tick = async (first = false) => {
      try {
        if (first && canEdit) await acquire();
        else await sync(await lockApi.heartbeat(project.id, sid));
      } catch {
        c.store.setState({ offline: true });
      }
      if (stopped) return;
      const holder = c.store.getState().state?.lock?.isMine;
      timer = setTimeout(() => void tick(), holder ? HOLDER_HEARTBEAT_MS : WAITING_POLL_MS);
    };
    void tick(true);

    // Another tab of this user is handing the lock over: save and stop editing here first.
    const ch =
      typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel(channelName(project.id))
        : null;
    if (ch)
      ch.onmessage = async (e: MessageEvent<TabMsg>) => {
        if (e.data.type !== 'freeze' || e.data.from === sid) return;
        const s = docStore.getState();
        if (s.queue.length) await s.flush();
        docStore.getState().setReadOnly(true, 'locked');
        ch.postMessage({ type: 'frozen', to: e.data.from } satisfies TabMsg);
      };

    const leave = () => {
      void lockApi.release(project.id, sid, { leave: true, keepalive: true }).catch(() => {});
    };
    window.addEventListener('pagehide', leave);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      ch?.close();
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [c, docStore, project.id, canEdit]);
}

/** Lock UI state and actions (for the indicator in the top bar). */
export function useEditLock(): LockController & LockUiState {
  const docStore = useDocStoreApi();
  const { project, can } = useEditor();
  const c = controllerFor(docStore, project.id, can('design:edit'));
  const ui = useStore(c.store);
  return { ...c, ...ui };
}
