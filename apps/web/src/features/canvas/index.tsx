'use client';

/**
 * Canvas feature slot (Epic 3). The editor shell imports CanvasPane, EditPanel and
 * EditLockIndicator from here; they read everything from useEditor() / useDocStore() and the
 * canvas store (mode, tool, edit session).
 */
export { CanvasPane } from './canvas-pane';
export { EditPanel } from './edit-panel';
export { EditLockIndicator } from './lock-indicator';
export {
  canEnterEdit,
  discardEditSession,
  saveEditSession,
  useCanvas,
  useCanvasStoreApi,
  type EditorMode,
} from './canvas-store';
export { nodeAtPoint } from './dom';
