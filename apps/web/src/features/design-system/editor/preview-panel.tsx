'use client';

import type { DesignSystemSpec } from '@crunch/doc-model';
import { FrameView } from '@crunch/renderer/react';
import { buildPreviewDoc, PREVIEW_FRAME_ID } from '../preview-doc';

/** Renders every token and component of `spec` through the real renderer (Story 4.1 AC). */
export function PreviewPanel({
  spec,
  theme,
  onTheme,
  stale,
}: {
  spec: DesignSystemSpec;
  theme: string | undefined;
  onTheme: (theme: string | undefined) => void;
  /** The working draft has errors, so this shows the last valid state. */
  stale: boolean;
}) {
  const doc = buildPreviewDoc(spec, { theme });
  const themes = Object.keys(spec.themes);
  return (
    <section className="card overflow-hidden" aria-label="Live preview">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-surface-2 px-3 py-2">
        <p className="text-sm font-medium">Live preview</p>
        <div className="flex items-center gap-2">
          {stale && <span className="text-xs text-danger">Showing last valid state</span>}
          {themes.length > 0 && (
            <select
              aria-label="Preview theme"
              className="input w-auto py-1 text-xs"
              value={theme ?? ''}
              onChange={(e) => onTheme(e.target.value || undefined)}
            >
              <option value="">Base theme</option>
              {themes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <div className="max-h-[calc(100vh-12rem)] overflow-auto">
        <FrameView doc={doc} ds={spec} frameId={PREVIEW_FRAME_ID} theme={theme} />
      </div>
    </section>
  );
}
