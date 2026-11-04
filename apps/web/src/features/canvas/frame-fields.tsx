'use client';

/** Frame fields for the edit panel when a frame (no node) is selected (Story 3.1). */
import { frameBreakpoint } from '@crunch/canvas';
import type { DocOp, Frame } from '@crunch/doc-model';
import { useDocStore, useDocStoreApi, useEditor } from '../doc-store';

export function FrameFields({ frame }: { frame: Frame }) {
  const readOnly = useDocStore((s) => s.readOnly);
  const docStore = useDocStoreApi();
  const { designSystem } = useEditor();
  const update = (patch: Extract<DocOp, { op: 'updateFrame' }>['patch'], label: string) =>
    docStore
      .getState()
      .apply([{ op: 'updateFrame', id: frame.id, patch }], { source: 'inspector', label });
  const num = (
    label: string,
    value: number,
    min: number,
    max: number,
    set: (n: number) => void,
  ) => (
    <label className="flex h-7 items-center gap-2 rounded-md bg-surface-2 px-2">
      <span className="shrink-0 text-muted">{label}</span>
      <input
        key={value}
        aria-label={`Frame ${label.toLowerCase()}`}
        type="number"
        disabled={readOnly}
        defaultValue={value}
        className="min-w-0 flex-1 bg-transparent text-right tabular-nums outline-none"
        onBlur={(e) => {
          const n = Math.round(Number(e.target.value));
          if (Number.isFinite(n) && n !== value && n >= min && n <= max) set(n);
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
    </label>
  );
  return (
    <div data-testid="frame-inspector" className="space-y-1.5 p-3 text-xs">
      <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">Frame</h3>
      <label className="flex h-7 items-center gap-2 rounded-md bg-surface-2 px-2">
        <span className="shrink-0 text-muted">Name</span>
        <input
          key={frame.name}
          aria-label="Frame name"
          disabled={readOnly}
          defaultValue={frame.name}
          maxLength={120}
          className="min-w-0 flex-1 bg-transparent text-right outline-none"
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name && name !== frame.name) update({ name }, 'Rename frame');
          }}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </label>
      {num('Width', frame.width, 160, 4096, (width) => update({ width }, 'Resize frame'))}
      <label className="flex h-7 items-center gap-2 px-2">
        <span className="text-muted">Height</span>
        <input
          type="checkbox"
          aria-label="Auto height"
          disabled={readOnly}
          checked={frame.height === 'auto'}
          onChange={(e) => update({ height: e.target.checked ? 'auto' : 800 }, 'Frame height')}
        />
        <span>Auto</span>
      </label>
      {frame.height !== 'auto' &&
        num('Min height', frame.height, 80, 32768, (height) => update({ height }, 'Frame height'))}
      {num('X', Math.round(frame.canvas.x), -1e6, 1e6, (x) =>
        update({ canvas: { ...frame.canvas, x } }, 'Move frame'),
      )}
      {num('Y', Math.round(frame.canvas.y), -1e6, 1e6, (y) =>
        update({ canvas: { ...frame.canvas, y } }, 'Move frame'),
      )}
      <p className="text-muted">
        Renders at the {frameBreakpoint(frame, designSystem.spec)} breakpoint.
      </p>
    </div>
  );
}
