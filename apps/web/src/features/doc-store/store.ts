/**
 * Client DesignDoc store (Stories 2.5 client side, 3.7 undo/redo).
 *
 * - `apply(ops)` updates the doc optimistically, records one undo step, and queues the change.
 *   Consecutive applies with the same `coalesceKey` (slider drag, typing) merge into one step.
 * - Queued changes are flushed to the server as one transaction per flush (debounced).
 * - On 409 conflict (another tab/user wrote), the store refetches the server doc and re-applies
 *   unsent local changes on top (rebase). Local changes that no longer apply are dropped and
 *   reported in `notice`.
 * - On 423 locked, the store becomes read-only and reloads the server state.
 * - Viewers and non-lock-holders poll for remote changes (`?since=`).
 *
 * Framework-free (zustand/vanilla). React bindings are in ./react.tsx.
 */
import { applyOps, OpError, type DesignDoc, type DocOp, type OpSource } from '@crunch/doc-model';
import { createStore, type StoreApi } from 'zustand/vanilla';

export interface DocApi {
  fetchDoc(projectId: string): Promise<{ version: number; doc: DesignDoc }>;
  commit(
    projectId: string,
    body: {
      baseVersion: number;
      txn: { id: string; source: OpSource; label?: string; ops: DocOp[] };
    },
  ): Promise<
    | { ok: true; version: number }
    | { ok: false; status: number; error: string; message: string; version?: number }
  >;
  since(
    projectId: string,
    version: number,
  ): Promise<{ version: number; txns: { version: number; ops: DocOp[] }[]; reset: boolean }>;
}

export interface UndoStep {
  label?: string;
  source: OpSource;
  ops: DocOp[];
  inverse: DocOp[];
  coalesceKey?: string;
  at: number;
}

export type SyncStatus = 'idle' | 'pending' | 'saving' | 'error' | 'offline';

export interface Selection {
  frameId: string | null;
  nodeIds: string[];
}

export interface DocState {
  projectId: string;
  /** Last version acknowledged by the server. */
  serverVersion: number;
  /** Server doc at serverVersion (rebase base). */
  serverDoc: DesignDoc;
  /** Optimistic local doc (server doc + unsent changes). */
  doc: DesignDoc;
  /** Local changes not yet acknowledged, in order. */
  queue: { source: OpSource; label?: string; ops: DocOp[] }[];
  undoStack: UndoStep[];
  redoStack: UndoStep[];
  readOnly: boolean;
  /** Why the doc is read-only (role, lock), for UI. */
  readOnlyReason: 'role' | 'locked' | null;
  status: SyncStatus;
  /** Last user-facing notice (dropped changes, errors). */
  notice: string | null;
  selection: Selection;
}

export interface DocActions {
  /** Apply ops locally and queue them. Returns false if rejected (invalid or read-only). */
  apply(ops: DocOp[], meta: { source: OpSource; label?: string; coalesceKey?: string }): boolean;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  select(selection: Partial<Selection>): void;
  setReadOnly(readOnly: boolean, reason?: DocState['readOnlyReason']): void;
  /** Send queued changes now. Resolves when the queue is empty or a terminal error occurs. */
  flush(): Promise<void>;
  /** Pull remote changes (polling viewers). */
  pull(): Promise<void>;
  /** Replace local state with the server's (after a lock loss, or a manual reload). */
  reload(): Promise<void>;
  dismissNotice(): void;
  dispose(): void;
}

export type DocStore = StoreApi<DocState & DocActions>;

export interface DocStoreOptions {
  projectId: string;
  version: number;
  doc: DesignDoc;
  readOnly: boolean;
  api: DocApi;
  /** Flush debounce (ms). */
  debounceMs?: number;
  /** Coalesce window for same-key applies (ms). */
  coalesceMs?: number;
  maxUndo?: number;
  now?: () => number;
}

const MAX_UNDO = 200;

export function createDocStore(opts: DocStoreOptions): DocStore {
  const { api } = opts;
  const debounceMs = opts.debounceMs ?? 400;
  const coalesceMs = opts.coalesceMs ?? 800;
  const maxUndo = opts.maxUndo ?? MAX_UNDO;
  const now = opts.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing: Promise<void> | null = null;
  let disposed = false;

  const store = createStore<DocState & DocActions>()((set, get) => {
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void get().flush(), debounceMs);
    };

    const enqueue = (ops: DocOp[], source: OpSource, label?: string) => {
      set((s) => ({ queue: [...s.queue, { source, label, ops }], status: 'pending' }));
      schedule();
    };

    /** Rebase unsent changes onto a fresh server doc. */
    const rebase = (serverDoc: DesignDoc, serverVersion: number) => {
      const s = get();
      let doc = serverDoc;
      const kept: DocState['queue'] = [];
      let dropped = 0;
      for (const q of s.queue) {
        try {
          doc = applyOps(doc, q.ops).doc;
          kept.push(q);
        } catch {
          dropped++;
        }
      }
      set({
        serverDoc,
        serverVersion,
        doc,
        queue: kept,
        // Undo history may reference state that no longer exists; keep it only if nothing was dropped.
        undoStack: dropped ? [] : s.undoStack,
        redoStack: [],
        notice: dropped
          ? `${dropped} change${dropped === 1 ? '' : 's'} conflicted with newer edits and were discarded.`
          : s.notice,
      });
    };

    const sendOnce = async (): Promise<'done' | 'again' | 'stop'> => {
      const s = get();
      if (!s.queue.length) return 'done';
      const batch = s.queue;
      const ops = batch.flatMap((q) => q.ops);
      const sources = new Set(batch.map((q) => q.source));
      const source: OpSource = sources.size === 1 ? batch[0]!.source : 'canvas';
      const txn = {
        id: crypto.randomUUID(),
        source,
        label: batch.length === 1 ? batch[0]!.label : undefined,
        ops,
      };
      set({ status: 'saving' });
      let res;
      try {
        res = await api.commit(s.projectId, { baseVersion: s.serverVersion, txn });
      } catch {
        set({ status: 'offline' });
        return 'stop';
      }
      if (disposed) return 'stop';
      if (res.ok) {
        // Server state = old server doc + this batch (the server applied the same ops).
        const serverDoc = applyOps(get().serverDoc, ops).doc;
        set((cur) => ({
          serverDoc,
          serverVersion: res.version,
          queue: cur.queue.slice(batch.length),
          status: cur.queue.length > batch.length ? 'pending' : 'idle',
        }));
        return get().queue.length ? 'again' : 'done';
      }
      if (res.status === 409) {
        const fresh = await api.fetchDoc(s.projectId);
        rebase(fresh.doc, fresh.version);
        return 'again';
      }
      if (res.status === 423) {
        set({
          notice: 'Someone else is editing this project. Your unsaved changes were not applied.',
        });
        get().setReadOnly(true, 'locked');
        await get().reload();
        return 'stop';
      }
      if (res.status === 400) {
        // The server rejected the batch as invalid: drop it and resync.
        set({ notice: `A change was rejected: ${res.message}` });
        const fresh = await api.fetchDoc(s.projectId);
        set({ queue: get().queue.slice(batch.length) });
        rebase(fresh.doc, fresh.version);
        return 'again';
      }
      set({ status: 'error', notice: res.message || 'Could not save changes' });
      return 'stop';
    };

    return {
      projectId: opts.projectId,
      serverVersion: opts.version,
      serverDoc: opts.doc,
      doc: opts.doc,
      queue: [],
      undoStack: [],
      redoStack: [],
      readOnly: opts.readOnly,
      readOnlyReason: opts.readOnly ? 'role' : null,
      status: 'idle',
      notice: null,
      selection: { frameId: opts.doc.frames[0]?.id ?? null, nodeIds: [] },

      apply(ops, meta) {
        const s = get();
        if (s.readOnly || !ops.length) return false;
        let result;
        try {
          result = applyOps(s.doc, ops);
        } catch (e) {
          if (e instanceof OpError) {
            set({ notice: e.message });
            return false;
          }
          throw e;
        }
        const t = now();
        const last = s.undoStack[s.undoStack.length - 1];
        let undoStack: UndoStep[];
        if (
          meta.coalesceKey &&
          last?.coalesceKey === meta.coalesceKey &&
          t - last.at < coalesceMs
        ) {
          undoStack = [
            ...s.undoStack.slice(0, -1),
            {
              ...last,
              ops: [...last.ops, ...ops],
              inverse: [...result.inverse, ...last.inverse],
              at: t,
            },
          ];
        } else {
          undoStack = [
            ...s.undoStack,
            {
              label: meta.label,
              source: meta.source,
              ops,
              inverse: result.inverse,
              coalesceKey: meta.coalesceKey,
              at: t,
            },
          ].slice(-maxUndo);
        }
        set({ doc: result.doc, undoStack, redoStack: [] });
        enqueue(ops, meta.source, meta.label);
        return true;
      },

      undo() {
        const s = get();
        const step = s.undoStack[s.undoStack.length - 1];
        if (s.readOnly || !step) return;
        try {
          const r = applyOps(s.doc, step.inverse);
          set({
            doc: r.doc,
            undoStack: s.undoStack.slice(0, -1),
            redoStack: [
              ...s.redoStack,
              { ...step, ops: step.inverse, inverse: r.inverse, coalesceKey: undefined },
            ],
          });
          enqueue(step.inverse, step.source, step.label ? `Undo ${step.label}` : 'Undo');
        } catch {
          // Remote edits made this step inapplicable.
          set({
            undoStack: s.undoStack.slice(0, -1),
            notice: 'That change can no longer be undone.',
          });
        }
      },

      redo() {
        const s = get();
        const step = s.redoStack[s.redoStack.length - 1];
        if (s.readOnly || !step) return;
        try {
          const r = applyOps(s.doc, step.inverse);
          set({
            doc: r.doc,
            redoStack: s.redoStack.slice(0, -1),
            undoStack: [...s.undoStack, { ...step, ops: step.inverse, inverse: r.inverse }],
          });
          enqueue(step.inverse, step.source, step.label ? `Redo ${step.label}` : 'Redo');
        } catch {
          set({
            redoStack: s.redoStack.slice(0, -1),
            notice: 'That change can no longer be redone.',
          });
        }
      },

      canUndo: () => !get().readOnly && get().undoStack.length > 0,
      canRedo: () => !get().readOnly && get().redoStack.length > 0,

      select(sel) {
        set((s) => ({ selection: { ...s.selection, ...sel } }));
      },

      setReadOnly(readOnly, reason = null) {
        set({ readOnly, readOnlyReason: readOnly ? (reason ?? 'role') : null });
      },

      async flush() {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (flushing) return flushing;
        flushing = (async () => {
          for (let i = 0; i < 20; i++) {
            const r = await sendOnce();
            if (r !== 'again') break;
          }
        })().finally(() => {
          flushing = null;
        });
        return flushing;
      },

      async pull() {
        const s = get();
        if (s.queue.length || flushing) return; // our own writes are in flight; flush handles sync
        const r = await api.since(s.projectId, s.serverVersion);
        if (disposed || r.version === s.serverVersion) return;
        if (r.reset) return get().reload();
        let doc = s.serverDoc;
        try {
          for (const t of r.txns) doc = applyOps(doc, t.ops).doc;
        } catch {
          return get().reload();
        }
        // Remote changes invalidate local undo history (it may target replaced state).
        set({ serverDoc: doc, serverVersion: r.version, doc, undoStack: [], redoStack: [] });
      },

      async reload() {
        const fresh = await api.fetchDoc(get().projectId);
        set({
          serverDoc: fresh.doc,
          serverVersion: fresh.version,
          doc: fresh.doc,
          queue: [],
          undoStack: [],
          redoStack: [],
          status: 'idle',
        });
      },

      dismissNotice: () => set({ notice: null }),

      dispose() {
        disposed = true;
        if (timer) clearTimeout(timer);
      },
    };
  });
  return store;
}

/** Default API over the Story 2.5 route handlers. */
export const httpDocApi: DocApi = {
  async fetchDoc(projectId) {
    const r = await fetch(`/api/projects/${projectId}/doc`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`Failed to load document (${r.status})`);
    return r.json();
  },
  async commit(projectId, body) {
    const r = await fetch(`/api/projects/${projectId}/doc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, version: json.version };
    return {
      ok: false,
      status: r.status,
      error: json.error ?? 'error',
      message: json.message ?? 'Request failed',
      version: json.version,
    };
  },
  async since(projectId, version) {
    const r = await fetch(`/api/projects/${projectId}/doc?since=${version}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`Failed to sync (${r.status})`);
    return r.json();
  },
};
