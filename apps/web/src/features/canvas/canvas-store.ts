'use client';

/**
 * Canvas UI state that isn't part of the document: camera, viewport size, measured frame sizes,
 * hover, and the active gesture. One store per doc store, shared by the canvas and inspector panes
 * (they're siblings in the editor shell, so it's keyed off the doc store rather than a provider).
 *
 * The camera changes on every pan/zoom frame. The world layer applies it by subscribing and
 * writing `transform` directly, so frames never re-render for camera moves (ADR 0001).
 */
import { frameBreakpoint, type Camera, type Distance, type Rect, type Tool } from '@crunch/canvas';
import type { Breakpoint, DesignSystemSpec, Frame } from '@crunch/doc-model';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useDocStoreApi, type DocStore, type UndoStep } from '../doc-store';

export interface Size {
  width: number;
  height: number;
}

export interface CanvasState {
  camera: Camera;
  viewport: Size;
  /** Measured frame sizes in world px (auto-height frames grow with content). */
  sizes: Record<string, Size>;
  /** Node under the pointer (hover outline). */
  hover: { frameId: string; nodeId: string } | null;
  /** Active pointer gesture, so overlays and shortcuts can adapt. */
  gesture: null | 'pan' | 'frame-move' | 'frame-resize' | 'drag' | 'resize' | 'text';
  /** Bumped when frame layout changes without a camera move (overlays re-measure). */
  layoutTick: number;
  /** True once the camera has been fitted to the content for the first time. */
  fitted: boolean;
  /**
   * Editor mode. `view`: the canvas is a preview (pan/zoom only; clicks never select or edit).
   * `edit`: selection, drag, resize, text edit and insert tools; the left pane shows the edit
   * panel. `comment`: clicking an element opens the comment composer for it.
   */
  mode: EditorMode;
  setMode(m: EditorMode): void;
  /**
   * The edit session started when edit mode was entered: the undo steps that existed then, so
   * Discard can undo exactly what was done since. Null outside edit mode.
   */
  editSession: { before: ReadonlySet<UndoStep> } | null;
  /** Active tool (edit mode). Insert tools revert to 'select' after one insert. */
  tool: Tool;
  /** Pending payload for the image and component tools. */
  toolArg: { src?: string; componentId?: string } | null;
  setTool(t: Tool, arg?: CanvasState['toolArg']): void;
  /** Live preview of an insert-tool drag, in world coordinates. */
  insertBox: Rect | null;
  setInsertBox(r: Rect | null): void;
  /** Live preview of a frame move/resize gesture (committed as one op on release). */
  framePreview: { frameId: string; dx: number; dy: number; width?: number } | null;
  setFramePreview(p: CanvasState['framePreview']): void;
  /**
   * Inspector breakpoint override, scoped to the frame it was chosen in. Any other frame (and
   * every canvas gesture) uses the breakpoint the frame renders.
   */
  editBreakpoint: { frameId: string; bp: Breakpoint } | null;
  setEditBreakpoint(frameId: string, bp: Breakpoint | null): void;
  /** Short canvas message (why an action was refused). */
  message: string | null;
  setMessage(m: string | null): void;
  /** Drop indicator during a flow drag, in world coordinates. */
  drop: { line: Rect; container: Rect } | null;
  /** Smart guides during resize/absolute moves, in world coordinates. */
  guides: {
    lines: Rect[];
    /** Spacing guides: gaps to the nearest neighbours. */
    distances?: Distance[];
    label?: { x: number; y: number; text: string };
  } | null;
  setDrop(d: CanvasState['drop']): void;
  setGuides(g: CanvasState['guides']): void;
  setCamera(c: Camera): void;
  setViewport(s: Size): void;
  setSize(frameId: string, s: Size): void;
  setHover(h: CanvasState['hover']): void;
  setGesture(g: CanvasState['gesture']): void;
  bumpLayout(): void;
  setFitted(): void;
}

export type EditorMode = 'view' | 'edit' | 'comment';

export type CanvasStore = StoreApi<CanvasState>;

export function createCanvasStore(): CanvasStore {
  return createStore<CanvasState>()((set) => ({
    camera: { x: 48, y: 48, z: 0.5 },
    viewport: { width: 0, height: 0 },
    sizes: {},
    hover: null,
    gesture: null,
    layoutTick: 0,
    fitted: false,
    mode: 'view',
    setMode: (mode) => set({ mode, hover: null }),
    editSession: null,
    tool: 'select',
    toolArg: null,
    setTool: (tool, arg) => set({ tool, toolArg: tool === 'select' ? null : (arg ?? null) }),
    insertBox: null,
    setInsertBox: (insertBox) => set({ insertBox }),
    framePreview: null,
    editBreakpoint: null,
    drop: null,
    guides: null,
    setDrop: (drop) => set({ drop }),
    setGuides: (guides) => set({ guides }),
    setEditBreakpoint: (frameId, bp) => set({ editBreakpoint: bp ? { frameId, bp } : null }),
    message: null,
    setMessage: (message) => set({ message }),
    setFramePreview: (framePreview) => set({ framePreview }),
    setCamera: (camera) => set({ camera }),
    setViewport: (viewport) => set({ viewport }),
    setSize: (frameId, s) =>
      set((st) => {
        const prev = st.sizes[frameId];
        if (prev && prev.width === s.width && prev.height === s.height) return st;
        return { sizes: { ...st.sizes, [frameId]: s }, layoutTick: st.layoutTick + 1 };
      }),
    setHover: (hover) =>
      set((st) =>
        st.hover?.nodeId === hover?.nodeId && st.hover?.frameId === hover?.frameId ? st : { hover },
      ),
    setGesture: (gesture) => set({ gesture }),
    bumpLayout: () => set((st) => ({ layoutTick: st.layoutTick + 1 })),
    setFitted: () => set({ fitted: true }),
  }));
}

/** Inspector breakpoint: the override if it was chosen in this frame, else the frame's own. */
export function inspectorBreakpoint(
  override: CanvasState['editBreakpoint'],
  frame: Frame | undefined,
  ds: DesignSystemSpec,
): Breakpoint {
  if (frame && override?.frameId === frame.id) return override.bp;
  return frame ? frameBreakpoint(frame, ds) : 'base';
}

/**
 * Breakpoint canvas gestures (drag, resize, hug) write: always the one the frame renders, so a
 * gesture's result is what you see. The inspector override never applies to gestures.
 */
export function gestureBreakpoint(frame: Frame | undefined, ds: DesignSystemSpec): Breakpoint {
  return frame ? frameBreakpoint(frame, ds) : 'base';
}

const stores = new WeakMap<DocStore, CanvasStore>();

/**
 * Mode transitions, which need the doc store:
 * - Entering edit mode is refused for viewers and archived projects (the doc store is read-only
 *   by role), and starts an edit session (Discard undoes back to it).
 * - Leaving edit mode ends the session, clears the selection and hover, and resets the tool.
 */
function bindModes(doc: DocStore, canvas: CanvasStore) {
  canvas.setState({
    setMode: (mode) => {
      const prev = canvas.getState().mode;
      if (mode === prev) return;
      const d = doc.getState();
      if (mode === 'edit' && d.readOnly && d.readOnlyReason === 'role') return;
      if (mode === 'edit') {
        canvas.setState({ mode, hover: null, editSession: { before: new Set(d.undoStack) } });
        return;
      }
      canvas.setState({
        mode,
        hover: null,
        editSession: null,
        tool: 'select',
        toolArg: null,
        insertBox: null,
        drop: null,
        guides: null,
        editBreakpoint: null,
      });
      if (prev === 'edit') d.select({ nodeIds: [], frameId: null });
    },
  });
}

export function canvasStoreFor(doc: DocStore): CanvasStore {
  let s = stores.get(doc);
  if (!s) {
    s = createCanvasStore();
    bindModes(doc, s);
    stores.set(doc, s);
  }
  return s;
}

/** Can this user enter edit mode at all? (Viewers and archived projects can't.) */
export function canEnterEdit(info: {
  can(p: 'design:edit'): boolean;
  project: { archived?: boolean };
}): boolean {
  return info.can('design:edit') && !info.project.archived;
}

/**
 * Discard: undo every step recorded since the edit session started (steps that existed at the
 * start are kept), then return to view mode. Returns the number of steps undone.
 */
export function discardEditSession(doc: DocStore, canvas: CanvasStore): number {
  const session = canvas.getState().editSession;
  let undone = 0;
  if (session) {
    for (let guard = 0; guard < 10_000; guard++) {
      const st = doc.getState();
      const top = st.undoStack[st.undoStack.length - 1];
      if (!top || session.before.has(top) || st.readOnly) break;
      const depth = st.undoStack.length;
      st.undo();
      if (doc.getState().undoStack.length >= depth) break; // nothing popped
      undone++;
    }
  }
  canvas.getState().setMode('view');
  return undone;
}

/** Save: keep the session's changes (they already autosave), flush them, and return to view. */
export function saveEditSession(doc: DocStore, canvas: CanvasStore): Promise<void> {
  canvas.getState().setMode('view');
  return doc.getState().flush();
}

export function useCanvasStoreApi(): CanvasStore {
  return canvasStoreFor(useDocStoreApi());
}

export function useCanvas<T>(selector: (s: CanvasState) => T): T {
  return useStore(useCanvasStoreApi(), selector);
}
