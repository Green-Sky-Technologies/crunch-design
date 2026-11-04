'use client';

/**
 * Canvas feature slot (Epic 3). The editor shell imports CanvasPane, InspectorPane and
 * EditLockIndicator from here; they read everything from useEditor() / useDocStore().
 */
export { CanvasPane } from './canvas-pane';
export { InspectorPane } from './inspector';
export { EditLockIndicator } from './lock-indicator';
