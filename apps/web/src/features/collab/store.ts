/**
 * Client state for the collab feature: which panel is open, comment threads, and the latest
 * canvas OverlayApi (so the composer can measure the selected node). One store per editor tab;
 * it's module-level because the canvas renders our overlay in its own subtree.
 */
import type { OverlayApi } from '@crunch/contracts/canvas-overlay';
import type { DesignDoc } from '@crunch/doc-model';
import { create } from 'zustand';
import { commentsApi, type Thread } from './api';

export type CollabPanel = 'comments' | 'versions' | 'share' | 'activity' | null;

/** Ask-agent delivery state per thread (Story 5.7). */
export type AgentState =
  | { status: 'sending' }
  | { status: 'sent'; conversationId: string; streamUrl: string }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

export interface CollabState {
  projectId: string | null;
  panel: CollabPanel;
  threads: Thread[];
  loaded: boolean;
  loadError: string | null;
  showResolved: boolean;
  focusedThreadId: string | null;
  overlayApi: OverlayApi | null;
  agent: Record<string, AgentState>;
  /** The editor's live doc (mirrored by CollabControls) so pins track moves/deletes instantly. */
  doc: DesignDoc | null;

  setPanel(p: CollabPanel): void;
  togglePanel(p: Exclude<CollabPanel, null>): void;
  setShowResolved(v: boolean): void;
  focusThread(id: string | null): void;
  setOverlayApi(api: OverlayApi | null): void;
  setAgentState(threadId: string, s: AgentState): void;
  setDoc(doc: DesignDoc | null): void;
  load(projectId: string): Promise<void>;
  upsertThread(t: Thread): void;
}

export const useCollab = create<CollabState>()((set, get) => ({
  projectId: null,
  panel: null,
  threads: [],
  loaded: false,
  loadError: null,
  showResolved: false,
  focusedThreadId: null,
  overlayApi: null,
  agent: {},
  doc: null,

  setPanel: (panel) => set({ panel }),
  togglePanel: (p) => set((s) => ({ panel: s.panel === p ? null : p })),
  setShowResolved: (showResolved) => set({ showResolved }),
  focusThread: (focusedThreadId) =>
    set(focusedThreadId ? { focusedThreadId, panel: 'comments' } : { focusedThreadId }),
  setOverlayApi: (overlayApi) => {
    if (get().overlayApi !== overlayApi) set({ overlayApi });
  },
  setDoc: (doc) => {
    if (get().doc !== doc) set({ doc });
  },
  setAgentState: (threadId, s) => set((st) => ({ agent: { ...st.agent, [threadId]: s } })),

  async load(projectId) {
    if (get().projectId !== projectId)
      set({ projectId, threads: [], loaded: false, focusedThreadId: null, agent: {} });
    try {
      const { threads } = await commentsApi.list(projectId);
      if (get().projectId === projectId) set({ threads, loaded: true, loadError: null });
    } catch (e) {
      if (get().projectId === projectId)
        set({ loaded: true, loadError: e instanceof Error ? e.message : 'Failed to load' });
    }
  },

  upsertThread(t) {
    set((s) => {
      const i = s.threads.findIndex((x) => x.id === t.id);
      if (i === -1) return { threads: [t, ...s.threads] };
      const threads = s.threads.slice();
      threads[i] = t;
      return { threads };
    });
  },
}));

/** Overlay coordinates → canvas coordinates, assuming the canvas uses a uniform pan/zoom transform. */
export function overlayToCanvas(api: OverlayApi, p: { x: number; y: number }) {
  const o = api.canvasToOverlay({ x: 0, y: 0 });
  const z = api.zoom || 1;
  return { x: (p.x - o.x) / z, y: (p.y - o.y) / z };
}
