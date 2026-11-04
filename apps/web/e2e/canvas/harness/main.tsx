/**
 * Canvas e2e harness (Story 3.9). Renders the real canvas feature (CanvasPane, InspectorPane,
 * EditLockIndicator) inside EditorProvider, against an in-memory doc API, so Playwright can
 * drive the editor in Chromium, Firefox and WebKit without a Clerk session. Auth isn't weakened:
 * this page is bundled by the test runner and never served by the app.
 *
 * Query params: fixture=sample|empty|bench<N> (N frames of ~300 nodes), role=editor|viewer|admin, user=<id>, lock=other
 */
import { permissionsFor, type Role } from '@crunch/authz';
import {
  applyOps,
  initialDoc,
  sampleLandingDoc,
  starterDesignSystem,
  type DesignDoc,
} from '@crunch/doc-model';
import { useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { canvasStoreFor } from '@/features/canvas/canvas-store';
import { setLockApi, type LockState } from '@/features/canvas/lock';
import { CanvasPane, EditLockIndicator, InspectorPane } from '@/features/canvas';
import {
  EditorProvider,
  useDocStore,
  useDocStoreApi,
  type DocApi,
  type DocStore,
} from '@/features/doc-store';
import { benchDoc } from './bench-doc';

const params = new URLSearchParams(location.search);
const role = (params.get('role') ?? 'editor') as Role;
const fixture = params.get('fixture') ?? 'sample';
const initial: DesignDoc =
  fixture === 'empty'
    ? initialDoc()
    : fixture.startsWith('bench')
      ? benchDoc(Number(fixture.slice(5)) || 10)
      : sampleLandingDoc();

// Lock server: free by default; `lock=other` simulates a teammate holding the edit lock.
const bob = { userId: 'user_bob', name: 'Bob Builder', imageUrl: null };
const meUser = { userId: params.get('user') ?? 'user_e2e', name: 'E2E User', imageUrl: null };
let lockHolder: typeof bob | null = params.get('lock') === 'other' ? bob : null;
let requestedBy: typeof bob | null = null;
const lockState = (): LockState => ({
  lock: lockHolder
    ? {
        holder: lockHolder,
        isMine: lockHolder.userId === meUser.userId,
        isThisSession: lockHolder.userId === meUser.userId,
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        requestedBy,
      }
    : null,
  presence: [{ ...meUser, isMe: true }, ...(lockHolder === bob ? [{ ...bob, isMe: false }] : [])],
  canTakeOver: role === 'admin' && lockHolder === bob,
  ttlMs: 120_000,
});
setLockApi({
  acquire: async () => {
    const acquired = !lockHolder || lockHolder === meUser;
    if (acquired) lockHolder = meUser;
    return { acquired, state: lockState() };
  },
  heartbeat: async () => lockState(),
  release: async (_p, _s, opts) => {
    if (lockHolder === meUser) lockHolder = opts?.handoff && requestedBy ? requestedBy : null;
    requestedBy = null;
    return lockState();
  },
  request: async () => {
    if (lockHolder && lockHolder !== meUser) requestedBy = meUser;
    return lockState();
  },
  decline: async () => {
    requestedBy = null;
    return lockState();
  },
  takeOver: async () => {
    lockHolder = meUser;
    requestedBy = null;
    return lockState();
  },
});

/** Test control of the fake lock server (the "other user" side of lock transitions). */
const lockServer = {
  holder: () => lockHolder?.userId ?? null,
  requestedBy: () => requestedBy?.userId ?? null,
  /** Bob closes his tab (or his lock expires): the lock is free on the next poll. */
  otherLeaves: () => {
    if (lockHolder === bob) lockHolder = null;
    requestedBy = null;
  },
};

let serverDoc = initial;
let version = 0;
const commits: { label?: string; ops: unknown[] }[] = [];
const api: DocApi = {
  fetchDoc: async () => ({ version, doc: serverDoc }),
  commit: async (_p, body) => {
    serverDoc = applyOps(serverDoc, body.txn.ops).doc;
    version++;
    commits.push({ label: body.txn.label, ops: body.txn.ops });
    return { ok: true, version };
  },
  since: async () => ({ version, txns: [], reset: false }),
};

declare global {
  interface Window {
    __cd: {
      store: DocStore;
      canvas: ReturnType<typeof canvasStoreFor>;
      commits: typeof commits;
      serverDoc: () => DesignDoc;
      t0: number;
      lock: typeof lockServer;
    };
  }
}

const t0 = performance.now();

function Expose() {
  const store = useDocStoreApi();
  useLayoutEffect(() => {
    window.__cd = {
      store,
      canvas: canvasStoreFor(store),
      commits,
      serverDoc: () => serverDoc,
      t0,
      lock: lockServer,
    };
  }, [store]);
  return null;
}

function TopBar() {
  const undo = useDocStore((s) => s.undo);
  const redo = useDocStore((s) => s.redo);
  const canUndo = useDocStore((s) => s.canUndo());
  const status = useDocStore((s) => s.status);
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        height: 44,
        padding: '0 12px',
        borderBottom: '1px solid #e6e5e1',
      }}
    >
      <strong>Harness</strong>
      <EditLockIndicator />
      <span data-testid="save-status">{status}</span>
      <button onClick={undo} disabled={!canUndo} aria-label="Undo">
        Undo
      </button>
      <button onClick={redo} aria-label="Redo">
        Redo
      </button>
    </div>
  );
}

// "Project loaded": the doc is in memory and React starts rendering the editor (Story 3.10).
performance.mark('cd:load');
createRoot(document.getElementById('root')!).render(
  <EditorProvider
    api={api}
    pollMs={1_000_000}
    initial={{ version: 0, doc: initial }}
    info={{
      project: { id: '00000000-0000-4000-8000-000000000001', name: 'Harness', description: null },
      workspace: { id: 'w', slug: 'acme', name: 'Acme' },
      user: { id: params.get('user') ?? 'user_e2e', role },
      permissions: permissionsFor(role),
      designSystem: { id: 'd', name: 'Starter', version: null, spec: starterDesignSystem() },
      agentAvailable: false,
    }}
  >
    <Expose />
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <TopBar />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', flex: 1, minHeight: 0 }}>
        <section style={{ minWidth: 0, minHeight: 0 }}>
          <CanvasPane />
        </section>
        <aside style={{ overflow: 'auto', borderLeft: '1px solid #e6e5e1' }}>
          <InspectorPane />
        </aside>
      </div>
    </div>
  </EditorProvider>,
);
