/**
 * Test helpers for canvas component tests (happy-dom). Not imported by app code.
 * Renders the canvas + inspector against an in-memory DocApi.
 */
import { permissionsFor, type Role } from '@crunch/authz';
import { applyOps, sampleLandingDoc, starterDesignSystem, type DesignDoc } from '@crunch/doc-model';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { EditorProvider, useDocStoreApi, type DocApi, type DocStore } from '../doc-store';
import { setLockApi, type LockApi, type LockState } from './lock';

/** Lock server that always grants the lock (canvas tests that aren't about locking). */
const free: LockState = { lock: null, presence: [], canTakeOver: false, ttlMs: 120_000 };
export const grantingLockApi: LockApi = {
  acquire: async () => ({ acquired: true, state: free }),
  heartbeat: async () => free,
  release: async () => free,
  request: async () => free,
  decline: async () => free,
  takeOver: async () => free,
};
setLockApi(grantingLockApi);

export function memoryApi(initial: DesignDoc) {
  let doc = initial;
  let version = 0;
  const commits: unknown[][] = [];
  const api: DocApi = {
    fetchDoc: async () => ({ version, doc }),
    commit: async (_p, body) => {
      doc = applyOps(doc, body.txn.ops).doc;
      version++;
      commits.push(body.txn.ops);
      return { ok: true, version };
    },
    since: async () => ({ version, txns: [], reset: false }),
  };
  return { api, commits, server: () => doc };
}

export function renderEditor(
  ui: ReactNode,
  opts: { role?: Role; doc?: DesignDoc; userId?: string } = {},
) {
  const role = opts.role ?? 'editor';
  const mem = memoryApi(opts.doc ?? sampleLandingDoc());
  let store!: DocStore;
  function Grab() {
    store = useDocStoreApi();
    return null;
  }
  const utils = render(
    <EditorProvider
      api={mem.api}
      pollMs={1_000_000}
      initial={{ version: 0, doc: opts.doc ?? sampleLandingDoc() }}
      info={{
        project: { id: '00000000-0000-4000-8000-000000000001', name: 'Landing', description: null },
        workspace: { id: 'w', slug: 'acme', name: 'Acme' },
        user: { id: opts.userId ?? 'user_1', role },
        permissions: permissionsFor(role),
        designSystem: { id: 'd', name: 'Starter', version: null, spec: starterDesignSystem() },
        agentAvailable: false,
      }}
    >
      <Grab />
      {ui}
    </EditorProvider>,
  );
  return { ...utils, ...mem, store: () => store };
}

/** Give an element a fixed client rect (happy-dom has no layout). */
export function fakeRect(el: Element, r: { x: number; y: number; width: number; height: number }) {
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      x: r.x,
      y: r.y,
      left: r.x,
      top: r.y,
      width: r.width,
      height: r.height,
      right: r.x + r.width,
      bottom: r.y + r.height,
      toJSON: () => ({}),
    }) as DOMRect;
}

/** Shadow root content of a rendered frame. */
export const frameRoot = (frameId: string) =>
  document.querySelector(`[data-cd-frame-host="${frameId}"]`)?.shadowRoot ?? null;
