import { applyOps, sampleLandingDoc, type DesignDoc, type DocOp } from '@crunch/doc-model';
import { describe, expect, it, vi } from 'vitest';
import { createDocStore, type DocApi } from './store';

/** In-memory fake server with the same semantics as the real endpoint. */
function fakeServer(initial: DesignDoc) {
  let doc = initial;
  let version = 0;
  const log: { version: number; ops: DocOp[] }[] = [];
  let lockedBy: string | null = null;
  const api: DocApi = {
    fetchDoc: async () => ({ version, doc }),
    commit: async (_p, { baseVersion, txn }) => {
      if (lockedBy) return { ok: false, status: 423, error: 'locked', message: 'locked' };
      if (baseVersion !== version)
        return { ok: false, status: 409, error: 'conflict', message: 'stale', version };
      try {
        doc = applyOps(doc, txn.ops).doc;
      } catch (e) {
        return { ok: false, status: 400, error: 'invalid', message: (e as Error).message };
      }
      version++;
      log.push({ version, ops: txn.ops });
      return { ok: true, version };
    },
    since: async (_p, v) => ({ version, txns: log.filter((t) => t.version > v), reset: false }),
  };
  return {
    api,
    get doc() {
      return doc;
    },
    get version() {
      return version;
    },
    /** Simulate another client writing. */
    remote(ops: DocOp[]) {
      doc = applyOps(doc, ops).doc;
      version++;
      log.push({ version, ops });
    },
    lock(user: string | null) {
      lockedBy = user;
    },
  };
}

const rename = (text: string): DocOp => ({ op: 'setProps', id: 'n_herotitle1', patch: { text } });
const text = (doc: DesignDoc, id = 'n_herotitle1') =>
  (doc.nodes[id] as { props: { text: string } }).props.text;

function make(server = fakeServer(sampleLandingDoc()), readOnly = false) {
  let t = 0;
  const store = createDocStore({
    projectId: 'p',
    version: 0,
    doc: server.doc,
    readOnly,
    api: server.api,
    debounceMs: 1_000_000,
    now: () => t,
  });
  return { store, server, tick: (ms: number) => (t += ms) };
}

describe('doc store', () => {
  it('applies optimistically, flushes one transaction, and acknowledges', async () => {
    const { store, server } = make();
    store.getState().apply([rename('A')], { source: 'inspector' });
    store.getState().apply([rename('B')], { source: 'inspector' });
    expect(text(store.getState().doc)).toBe('B');
    expect(store.getState().status).toBe('pending');
    await store.getState().flush();
    expect(server.version).toBe(1); // both changes in one server txn
    expect(text(server.doc)).toBe('B');
    expect(store.getState()).toMatchObject({ serverVersion: 1, status: 'idle', queue: [] });
  });

  it('undo/redo are exact and each apply is one step', () => {
    const { store } = make();
    const s = store.getState;
    s().apply([rename('A')], { source: 'inspector', label: 'Edit text' });
    s().apply(
      [{ op: 'setStyle', id: 'n_hero000001', breakpoint: 'base', prop: 'gap', value: 40 }],
      { source: 'inspector' },
    );
    s().undo();
    expect(s().doc.nodes['n_hero000001']!.style.base?.gap).toEqual({ token: 'space.6' });
    s().undo();
    expect(s().doc).toEqual(sampleLandingDoc());
    expect(s().canUndo()).toBe(false);
    s().redo();
    s().redo();
    expect(text(s().doc)).toBe('A');
    expect(s().doc.nodes['n_hero000001']!.style.base?.gap).toBe(40);
  });

  it('coalesces same-key applies within the window (slider drag = one undo step)', () => {
    const { store, tick } = make();
    const s = store.getState;
    for (const v of [10, 20, 30]) {
      s().apply(
        [{ op: 'setStyle', id: 'n_features01', breakpoint: 'base', prop: 'gap', value: v }],
        { source: 'slider', coalesceKey: 'slider:density' },
      );
      tick(100);
    }
    expect(s().undoStack).toHaveLength(1);
    s().undo();
    expect(s().doc).toEqual(sampleLandingDoc());
    tick(5000);
    s().apply([{ op: 'setStyle', id: 'n_features01', breakpoint: 'base', prop: 'gap', value: 5 }], {
      source: 'slider',
      coalesceKey: 'slider:density',
    });
    expect(s().undoStack).toHaveLength(1);
  });

  it('rejects edits when read-only and invalid ops without corrupting state', () => {
    const { store } = make(undefined, true);
    expect(store.getState().apply([rename('A')], { source: 'canvas' })).toBe(false);
    store.getState().setReadOnly(false);
    expect(
      store.getState().apply([{ op: 'removeNode', id: 'n_missing0001' }], { source: 'canvas' }),
    ).toBe(false);
    expect(store.getState().notice).toMatch(/not found/);
    expect(store.getState().doc).toEqual(sampleLandingDoc());
  });

  it('rebases unsent changes onto remote edits after a conflict', async () => {
    const { store, server } = make();
    server.remote([{ op: 'setProps', id: 'n_herobody01', patch: { text: 'Remote' } }]);
    store.getState().apply([rename('Local')], { source: 'inspector' });
    await store.getState().flush();
    expect(server.version).toBe(2);
    expect(text(server.doc)).toBe('Local');
    expect(text(server.doc, 'n_herobody01')).toBe('Remote');
    expect(text(store.getState().doc, 'n_herobody01')).toBe('Remote');
  });

  it('drops local changes that no longer apply after rebase, with a notice', async () => {
    const { store, server } = make();
    server.remote([{ op: 'removeNode', id: 'n_hero000001' }]);
    store.getState().apply([rename('Gone')], { source: 'inspector' });
    await store.getState().flush();
    expect(store.getState().notice).toMatch(/discarded/);
    expect(store.getState().doc.nodes['n_herotitle1']).toBeUndefined();
    expect(store.getState().queue).toEqual([]);
  });

  it('goes read-only and reloads when another user holds the lock', async () => {
    const { store, server } = make();
    server.lock('someone');
    store.getState().apply([rename('Nope')], { source: 'inspector' });
    await store.getState().flush();
    expect(store.getState()).toMatchObject({ readOnly: true, readOnlyReason: 'locked', queue: [] });
    expect(text(store.getState().doc)).toBe(text(sampleLandingDoc()));
  });

  it('pulls remote changes for viewers', async () => {
    const { store, server } = make(undefined, true);
    server.remote([rename('From editor')]);
    await store.getState().pull();
    expect(text(store.getState().doc)).toBe('From editor');
    expect(store.getState().serverVersion).toBe(1);
  });

  it('reports offline on network failure and keeps the queue', async () => {
    const server = fakeServer(sampleLandingDoc());
    server.api.commit = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const { store } = make(server);
    store.getState().apply([rename('A')], { source: 'inspector' });
    await store.getState().flush();
    expect(store.getState()).toMatchObject({ status: 'offline' });
    expect(store.getState().queue).toHaveLength(1);
  });
});
