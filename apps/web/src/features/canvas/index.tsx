'use client';

/**
 * Canvas feature slot (Epic 3). The editor shell imports CanvasPane, InspectorPane and
 * EditLockIndicator from here; they read everything from useEditor() / useDocStore().
 */
import { useDocStore } from '../doc-store';

export { CanvasPane } from './canvas-pane';

export function InspectorPane() {
  const selection = useDocStore((s) => s.selection);
  return (
    <div className="p-4 text-sm text-muted">
      {selection.nodeIds.length
        ? `${selection.nodeIds.length} selected`
        : 'Select an element to edit it (Epic 3).'}
    </div>
  );
}

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
