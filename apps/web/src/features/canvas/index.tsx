'use client';

/**
 * Canvas feature slot (Epic 3). The editor shell imports CanvasPane, InspectorPane and
 * EditLockIndicator from here; they read everything from useEditor() / useDocStore().
 */
import { useDocStore } from '../doc-store';

export { CanvasPane } from './canvas-pane';
export { InspectorPane } from './inspector';

export function EditLockIndicator() {
  const readOnly = useDocStore((s) => s.readOnly);
  const reason = useDocStore((s) => s.readOnlyReason);
  if (!readOnly) return null;
  return (
    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">
      {reason === 'locked' ? 'Someone else is editing' : 'View only'}
    </span>
  );
}
