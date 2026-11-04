'use client';

/** React bindings for the doc store, plus the editor context every feature slot reads. */
import type { Permission, Role } from '@crunch/authz';
import type { DesignSystemSpec } from '@crunch/doc-model';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import {
  createDocStore,
  httpDocApi,
  type DocActions,
  type DocApi,
  type DocState,
  type DocStore,
} from './store';

export interface EditorInfo {
  project: { id: string; name: string; description: string | null };
  workspace: { id: string; slug: string; name: string };
  user: { id: string; role: Role };
  /** Permissions the current user has (from @crunch/authz). */
  permissions: readonly Permission[];
  designSystem: { id: string; name: string; version: number | null; spec: DesignSystemSpec };
  /** Workspace has a working model credential (agent usable). */
  agentAvailable: boolean;
}

const StoreCtx = createContext<DocStore | null>(null);
const EditorCtx = createContext<EditorInfo | null>(null);

export function EditorProvider({
  info,
  initial,
  api = httpDocApi,
  pollMs = 4000,
  children,
}: {
  info: EditorInfo;
  initial: { version: number; doc: DocState['doc'] };
  api?: DocApi;
  pollMs?: number;
  children: ReactNode;
}) {
  const [store] = useState(() =>
    createDocStore({
      projectId: info.project.id,
      version: initial.version,
      doc: initial.doc,
      readOnly: !info.permissions.includes('design:edit'),
      api,
    }),
  );

  // Flush on tab hide/unload; poll for remote changes when we aren't writing.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void store.getState().flush();
    };
    document.addEventListener('visibilitychange', onHide);
    const id = setInterval(() => {
      const s = store.getState();
      if (document.visibilityState === 'visible' && !s.queue.length) void s.pull().catch(() => {});
    }, pollMs);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      clearInterval(id);
      void store.getState().flush();
      store.getState().dispose();
    };
  }, [store, pollMs]);

  return (
    <EditorCtx.Provider value={info}>
      <StoreCtx.Provider value={store}>{children}</StoreCtx.Provider>
    </EditorCtx.Provider>
  );
}

/** Editor-wide info (project, user, permissions, design system). */
export function useEditor(): EditorInfo & { can: (p: Permission) => boolean } {
  const info = useContext(EditorCtx);
  if (!info) throw new Error('useEditor outside EditorProvider');
  return { ...info, can: (p) => info.permissions.includes(p) };
}

export function useDocStoreApi(): DocStore {
  const s = useContext(StoreCtx);
  if (!s) throw new Error('useDocStore outside EditorProvider');
  return s;
}

/** Select from the doc store; re-renders only when the selected value changes. */
export function useDocStore<T>(selector: (s: DocState & DocActions) => T): T {
  return useStore(useDocStoreApi(), selector);
}
