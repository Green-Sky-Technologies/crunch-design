'use client';

/**
 * Editor top-bar lint badge (Story 4.6): design-system checks on the live doc, run locally on
 * every edit at zero tokens. Clicking an issue selects its node.
 */
import { lintDoc, type LintIssue } from '@crunch/ds-lint';
import { useDeferredValue, useMemo, useState } from 'react';
import { useDocStore, useEditor } from '@/features/doc-store';

export function LintBadge() {
  const { designSystem } = useEditor();
  const doc = useDeferredValue(useDocStore((s) => s.doc));
  const select = useDocStore((s) => s.select);
  const issues = useMemo<LintIssue[]>(
    () => lintDoc(doc, designSystem.spec).filter((i) => i.severity !== 'info'),
    [doc, designSystem.spec],
  );
  const [open, setOpen] = useState(false);
  if (!issues.length) return null;
  const errors = issues.filter((i) => i.severity === 'error').length;
  return (
    <div className="relative">
      <button
        className={`btn-ghost px-2 py-1 text-xs ${errors ? 'text-danger' : 'text-muted'}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Design-system checks"
      >
        {issues.length} {issues.length === 1 ? 'issue' : 'issues'}
      </button>
      {open && (
        <ul className="card absolute right-0 z-50 mt-1 max-h-80 w-96 overflow-auto p-1 text-sm shadow-lg">
          {issues.slice(0, 50).map((i, idx) => (
            <li key={`${i.code}-${i.nodeId ?? ''}-${i.prop ?? ''}-${idx}`}>
              <button
                className="block w-full rounded px-2 py-1.5 text-left hover:bg-surface-2"
                onClick={() => {
                  if (i.nodeId) select({ nodeIds: [i.nodeId] });
                  setOpen(false);
                }}
              >
                <span className={i.severity === 'error' ? 'text-danger' : 'text-muted'}>
                  {i.severity === 'error' ? '●' : '○'}
                </span>{' '}
                {i.message}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
