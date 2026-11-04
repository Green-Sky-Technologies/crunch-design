'use client';

/**
 * STUB slot: stream-canvas (Epic 3) replaces these. Keep the export names stable. The editor
 * shell imports CanvasPane, InspectorPane and EditLockIndicator from here, and they read
 * everything from useEditor() / useDocStore(), so no props are needed.
 *
 * The stub renders frames read-only with the real renderer, plus a "sample design" helper.
 */
import { replaceDocOps, sampleLandingDoc } from '@crunch/doc-model';
import { FrameView } from '@crunch/renderer/react';
import { useDocStore, useEditor } from '../doc-store';

export function CanvasPane() {
  const { designSystem, can } = useEditor();
  const doc = useDocStore((s) => s.doc);
  const apply = useDocStore((s) => s.apply);
  const readOnly = useDocStore((s) => s.readOnly);
  const isEmpty = Object.keys(doc.nodes).length <= doc.frames.length;

  return (
    <div className="relative h-full overflow-auto bg-surface-2" data-testid="canvas">
      {isEmpty && can('design:edit') && !readOnly && (
        <div className="sticky top-3 z-10 mx-auto w-fit">
          <button
            className="btn-ghost shadow-sm"
            onClick={() =>
              apply(replaceDocOps(doc, sampleLandingDoc()), {
                source: 'import',
                label: 'Insert sample design',
              })
            }
          >
            Insert a sample design
          </button>
        </div>
      )}
      <div className="flex min-w-max items-start gap-12 p-12">
        {doc.frames.map((f) => (
          <figure key={f.id} className="shrink-0">
            <figcaption className="mb-2 text-xs text-muted">{f.name}</figcaption>
            <div className="bg-white shadow-sm ring-1 ring-border">
              <FrameView doc={doc} ds={designSystem.spec} frameId={f.id} />
            </div>
          </figure>
        ))}
      </div>
    </div>
  );
}

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
