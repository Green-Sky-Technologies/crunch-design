'use client';

/**
 * Screen-space frame chrome (Story 3.1): name labels (click to select, drag to move,
 * double-click to rename), the selected frame's outline, width handle, size presets and
 * duplicate/delete actions. Moves and resizes preview locally and commit one op on release,
 * so a gesture is always a single undo step.
 */
import { duplicateFrameOps, FRAME_PRESETS, frameRect, worldRectToScreen } from '@crunch/canvas';
import type { Frame } from '@crunch/doc-model';
import { useState } from 'react';
import { useDocStore, useDocStoreApi } from '../doc-store';
import { useCanvas, useCanvasStoreApi } from './canvas-store';
import { startGesture } from './gesture';

const ACCENT = 'var(--accent, #cb4b16)';

function FrameLabel({ frame, selected }: { frame: Frame; selected: boolean }) {
  const camera = useCanvas((s) => s.camera);
  const preview = useCanvas((s) => (s.framePreview?.frameId === frame.id ? s.framePreview : null));
  const docReadOnly = useDocStore((s) => s.readOnly);
  const editing = useCanvas((s) => s.mode === 'edit');
  // Outside edit mode labels are just labels: no selecting, moving or renaming.
  const readOnly = docReadOnly || !editing;
  const docStore = useDocStoreApi();
  const canvas = useCanvasStoreApi();
  const [renaming, setRenaming] = useState(false);

  const x = (frame.canvas.x + (preview?.dx ?? 0)) * camera.z + camera.x;
  const y = (frame.canvas.y + (preview?.dy ?? 0)) * camera.z + camera.y;
  const maxWidth = Math.max(40, (preview?.width ?? frame.width) * camera.z);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || renaming || !editing) return;
    e.stopPropagation();
    docStore.getState().select({ frameId: frame.id, nodeIds: [] });
    if (readOnly) return;
    const z = canvas.getState().camera.z;
    let last = { dx: 0, dy: 0 };
    startGesture(e, {
      onStart: () => canvas.getState().setGesture('frame-move'),
      onMove: (_e, dx, dy) => {
        last = { dx: Math.round(dx / z), dy: Math.round(dy / z) };
        canvas.getState().setFramePreview({ frameId: frame.id, ...last });
      },
      onEnd: (_e, moved) => {
        canvas.getState().setFramePreview(null);
        canvas.getState().setGesture(null);
        if (!moved || (!last.dx && !last.dy)) return;
        docStore.getState().apply(
          [
            {
              op: 'updateFrame',
              id: frame.id,
              patch: { canvas: { x: frame.canvas.x + last.dx, y: frame.canvas.y + last.dy } },
            },
          ],
          { source: 'canvas', label: 'Move frame' },
        );
      },
      onCancel: () => {
        canvas.getState().setFramePreview(null);
        canvas.getState().setGesture(null);
      },
    });
  };

  const commitName = (name: string) => {
    setRenaming(false);
    const trimmed = name.trim().slice(0, 120);
    if (!trimmed || trimmed === frame.name) return;
    docStore.getState().apply([{ op: 'updateFrame', id: frame.id, patch: { name: trimmed } }], {
      source: 'canvas',
      label: 'Rename frame',
    });
  };

  return (
    <div
      data-cd-frame-label={frame.id}
      onPointerDown={onPointerDown}
      onDoubleClick={() => !readOnly && setRenaming(true)}
      style={{
        position: 'absolute',
        left: x,
        top: y - 22,
        maxWidth,
        height: 20,
        pointerEvents: 'auto',
        cursor: readOnly ? 'default' : 'move',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        fontSize: 12,
        lineHeight: '20px',
        color: selected ? ACCENT : 'var(--muted, #657b83)',
        fontWeight: selected ? 600 : 400,
      }}
    >
      {renaming ? (
        <input
          autoFocus
          aria-label="Frame name"
          defaultValue={frame.name}
          maxLength={120}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={(e) => commitName(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commitName(e.currentTarget.value);
            if (e.key === 'Escape') setRenaming(false);
          }}
          style={{ font: 'inherit', height: 20, padding: '0 4px', width: Math.max(120, maxWidth) }}
        />
      ) : (
        frame.name
      )}
    </div>
  );
}

function SelectedFrame({ frame }: { frame: Frame }) {
  const camera = useCanvas((s) => s.camera);
  const sizes = useCanvas((s) => s.sizes);
  const preview = useCanvas((s) => (s.framePreview?.frameId === frame.id ? s.framePreview : null));
  const readOnly = useDocStore((s) => s.readOnly);
  const docStore = useDocStoreApi();
  const canvas = useCanvasStoreApi();

  const world = frameRect(frame, sizes);
  world.x += preview?.dx ?? 0;
  world.y += preview?.dy ?? 0;
  if (preview?.width) world.width = preview.width;
  const r = worldRectToScreen(camera, world);

  const apply = (patch: { width?: number }, label: string) =>
    docStore.getState().apply([{ op: 'updateFrame', id: frame.id, patch }], {
      source: 'canvas',
      label,
    });

  const onResizeDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const z = canvas.getState().camera.z;
    let width = frame.width;
    startGesture(e, {
      onStart: () => canvas.getState().setGesture('frame-resize'),
      onMove: (_e, dx) => {
        width = Math.min(4096, Math.max(160, Math.round(frame.width + dx / z)));
        canvas.getState().setFramePreview({ frameId: frame.id, dx: 0, dy: 0, width });
      },
      onEnd: () => {
        canvas.getState().setFramePreview(null);
        canvas.getState().setGesture(null);
        if (width !== frame.width) apply({ width }, 'Resize frame');
      },
      onCancel: () => {
        canvas.getState().setFramePreview(null);
        canvas.getState().setGesture(null);
      },
    });
  };

  return (
    <>
      <div
        data-cd-frame-outline={frame.id}
        style={{
          position: 'absolute',
          left: r.x,
          top: r.y,
          width: r.width,
          height: r.height,
          outline: `2px solid ${ACCENT}`,
        }}
      />
      {!readOnly && (
        <>
          <div
            role="slider"
            aria-label="Frame width"
            aria-valuenow={preview?.width ?? frame.width}
            data-cd-frame-resize={frame.id}
            onPointerDown={onResizeDown}
            style={{
              position: 'absolute',
              left: r.x + r.width - 4,
              top: r.y + Math.min(r.height, 400) / 2 - 20,
              width: 8,
              height: 40,
              borderRadius: 4,
              background: ACCENT,
              cursor: 'ew-resize',
              pointerEvents: 'auto',
            }}
          />
          {preview?.width && (
            <div
              style={{
                position: 'absolute',
                left: r.x + r.width + 8,
                top: r.y + Math.min(r.height, 400) / 2 - 10,
                fontSize: 11,
                padding: '1px 4px',
                borderRadius: 3,
                background: ACCENT,
                color: '#fff',
              }}
            >
              {preview.width}px
            </div>
          )}
          <div
            className="card shadow-sm"
            style={{
              position: 'absolute',
              // Above the frame's right edge, or beside it when the frame is too narrow on screen.
              left: r.width >= 420 ? r.x + r.width - 260 : r.x + r.width + 12,
              top: r.width >= 420 ? r.y - 30 : r.y,
              display: 'flex',
              gap: 4,
              alignItems: 'center',
              padding: '2px 4px',
              pointerEvents: 'auto',
              fontSize: 12,
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <select
              aria-label="Frame size"
              value={FRAME_PRESETS.some((p) => p.width === frame.width) ? frame.width : ''}
              onChange={(e) => apply({ width: Number(e.target.value) }, 'Resize frame')}
              style={{ fontSize: 12, background: 'transparent' }}
            >
              <option value="" disabled>
                {frame.width}px
              </option>
              {FRAME_PRESETS.map((p) => (
                <option key={p.label} value={p.width}>
                  {p.label} · {p.width}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="rounded px-1.5 hover:bg-surface-2"
              onClick={() => {
                const s = docStore.getState();
                const dup = duplicateFrameOps(s.doc, frame.id);
                if (dup && s.apply(dup.ops, { source: 'canvas', label: 'Duplicate frame' }))
                  s.select({ frameId: dup.frameId, nodeIds: [] });
              }}
            >
              Duplicate
            </button>
            <button
              type="button"
              className="rounded px-1.5 text-danger hover:bg-surface-2"
              onClick={() => {
                const s = docStore.getState();
                if (
                  s.apply([{ op: 'removeFrame', id: frame.id }], {
                    source: 'canvas',
                    label: 'Delete frame',
                  })
                )
                  s.select({ frameId: null, nodeIds: [] });
              }}
            >
              Delete
            </button>
          </div>
        </>
      )}
    </>
  );
}

export function FrameChrome() {
  const frames = useDocStore((s) => s.doc.frames);
  const selection = useDocStore((s) => s.selection);
  const editing = useCanvas((s) => s.mode === 'edit');
  const selectedFrame =
    editing && selection.nodeIds.length === 0
      ? frames.find((f) => f.id === selection.frameId)
      : undefined;
  return (
    <>
      {frames.map((f) => (
        <FrameLabel key={f.id} frame={f} selected={editing && f.id === selection.frameId} />
      ))}
      {selectedFrame && <SelectedFrame frame={selectedFrame} />}
    </>
  );
}
