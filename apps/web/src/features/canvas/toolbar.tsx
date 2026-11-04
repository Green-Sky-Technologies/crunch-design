'use client';

/** Canvas toolbar: add frame, zoom controls, fit, and the empty-project sample helper. */
import { addFrameOps, centerOn, FRAME_PRESETS, stepZoom, zoomAt } from '@crunch/canvas';
import { replaceDocOps, sampleLandingDoc } from '@crunch/doc-model';
import { useState } from 'react';
import { useDocStore, useDocStoreApi, useEditor } from '../doc-store';
import { fitAll } from './camera-actions';
import { useCanvas, useCanvasStoreApi } from './canvas-store';

export function CanvasToolbar() {
  const { can } = useEditor();
  const readOnly = useDocStore((s) => s.readOnly);
  const isEmpty = useDocStore((s) => Object.keys(s.doc.nodes).length <= s.doc.frames.length);
  const zoom = useCanvas((s) => s.camera.z);
  const layersOpen = useCanvas((s) => s.layersOpen);
  const docStore = useDocStoreApi();
  const canvas = useCanvasStoreApi();
  const [menu, setMenu] = useState(false);
  const editable = can('design:edit') && !readOnly;

  const zoomTo = (z: number) => {
    const st = canvas.getState();
    st.setCamera(zoomAt(st.camera, { x: st.viewport.width / 2, y: st.viewport.height / 2 }, z));
  };

  const addFrame = (preset: (typeof FRAME_PRESETS)[number]) => {
    setMenu(false);
    const s = docStore.getState();
    const { ops, frameId } = addFrameOps(s.doc, {
      name: preset.label,
      width: preset.width,
      height: preset.height,
    });
    if (!s.apply(ops, { source: 'canvas', label: 'Add frame' })) return;
    s.select({ frameId, nodeIds: [] });
    const f = docStore.getState().doc.frames.find((x) => x.id === frameId)!;
    const st = canvas.getState();
    st.setCamera(
      centerOn(st.camera, { x: f.canvas.x + f.width / 2, y: f.canvas.y + 300 }, st.viewport),
    );
  };

  return (
    <>
      <div
        className="card shadow-sm"
        style={{
          position: 'absolute',
          left: 12,
          bottom: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: 2,
          fontSize: 12,
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className={`rounded px-2 py-1 hover:bg-surface-2 ${layersOpen ? 'text-accent' : ''}`}
          aria-pressed={layersOpen}
          onClick={() => canvas.getState().toggleLayers()}
        >
          Layers
        </button>
        {editable && (
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="rounded px-2 py-1 hover:bg-surface-2"
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={() => setMenu((m) => !m)}
            >
              + Frame
            </button>
            {menu && (
              <div
                role="menu"
                className="card shadow-lg"
                style={{
                  position: 'absolute',
                  bottom: '100%',
                  left: 0,
                  marginBottom: 4,
                  minWidth: 150,
                }}
              >
                {FRAME_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    role="menuitem"
                    type="button"
                    className="block w-full px-3 py-1.5 text-left hover:bg-surface-2"
                    onClick={() => addFrame(p)}
                  >
                    {p.label} <span className="text-muted">{p.width}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          className="rounded px-2 py-1 hover:bg-surface-2"
          aria-label="Zoom out"
          onClick={() => zoomTo(stepZoom(zoom, -1))}
        >
          −
        </button>
        <button
          type="button"
          className="rounded px-1 py-1 tabular-nums hover:bg-surface-2"
          aria-label="Reset zoom to 100%"
          title="Reset to 100%"
          onClick={() => zoomTo(1)}
          style={{ minWidth: 44 }}
        >
          <span data-testid="zoom-level">{Math.round(zoom * 100)}%</span>
        </button>
        <button
          type="button"
          className="rounded px-2 py-1 hover:bg-surface-2"
          aria-label="Zoom in"
          onClick={() => zoomTo(stepZoom(zoom, 1))}
        >
          +
        </button>
        <button
          type="button"
          className="rounded px-2 py-1 hover:bg-surface-2"
          onClick={() => fitAll(canvas, docStore.getState().doc)}
        >
          Fit
        </button>
      </div>
      {isEmpty && editable && (
        <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)' }}>
          <button
            className="btn-ghost shadow-sm"
            onClick={() => {
              const s = docStore.getState();
              if (
                s.apply(replaceDocOps(s.doc, sampleLandingDoc()), {
                  source: 'import',
                  label: 'Insert sample design',
                })
              )
                requestAnimationFrame(() => fitAll(canvas, docStore.getState().doc));
            }}
          >
            Insert a sample design
          </button>
        </div>
      )}
    </>
  );
}
