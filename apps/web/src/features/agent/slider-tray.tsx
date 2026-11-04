'use client';

/**
 * Slider tray (Story 5.8). Agent-proposed sliders bound to style props or tokens. Dragging
 * applies ops locally through the doc store (zero tokens) and lands as one undo step per drag.
 * Sliders can be pinned, renamed and deleted. Viewers see them read-only.
 */
import { sliderOps, snap } from '@crunch/agent/sliders';
import type { DocOp, Slider } from '@crunch/doc-model';
import { useRef, useState } from 'react';
import type { DocStore } from '../doc-store';
import { useDocStore, useDocStoreApi, useEditor } from '../doc-store';

/**
 * Collapse everything a drag pushed onto the undo stack into a single step. The store already
 * coalesces same-key applies, but a pause longer than its window would split the drag.
 */
export function finishDrag(
  store: DocStore,
  startDepth: number,
  slider: Slider,
  finalValue: number,
  label: string,
) {
  const s = store.getState();
  const steps = s.undoStack.length - startDepth;
  if (steps <= 1) return;
  for (let i = 0; i < steps; i++) store.getState().undo();
  const ops = sliderOps(store.getState().doc, slider, finalValue);
  store.getState().apply(ops, { source: 'slider', label });
}

function SliderRow({ slider, editable }: { slider: Slider; editable: boolean }) {
  const store = useDocStoreApi();
  const drag = useRef<{ key: string; depth: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(slider.label);

  const apply = (ops: DocOp[], label: string, coalesceKey?: string) =>
    store.getState().apply(ops, { source: 'slider', label, coalesceKey });

  const begin = () => {
    drag.current ??= {
      key: `slider:${slider.id}:${Date.now()}`,
      depth: store.getState().undoStack.length,
    };
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const current = store.getState().doc.sliders.find((s) => s.id === slider.id);
    if (current) finishDrag(store, d.depth, current, current.value, `Adjust ${slider.label}`);
  };
  const onValue = (raw: number) => {
    const current = store.getState().doc.sliders.find((s) => s.id === slider.id) ?? slider;
    const value = snap(current, raw);
    if (value === current.value) return;
    const key = drag.current?.key ?? `slider:${slider.id}:kbd`;
    apply(sliderOps(store.getState().doc, current, value), `Adjust ${slider.label}`, key);
  };
  const update = (patch: Partial<Slider>, label: string) =>
    apply([{ op: 'upsertSlider', slider: { ...slider, ...patch } }], label);

  return (
    <li className="py-1.5" data-testid={`slider-${slider.id}`}>
      <div className="flex items-center gap-2 text-xs">
        {renaming ? (
          <input
            className="input py-0.5 text-xs"
            value={name}
            maxLength={60}
            autoFocus
            aria-label="Slider name"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              setRenaming(false);
              const label = name.trim();
              if (label && label !== slider.label) update({ label }, 'Rename slider');
              else setName(slider.label);
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <span className="flex-1 truncate font-medium">{slider.label}</span>
        )}
        <span className="tabular-nums text-muted">{slider.value}</span>
        {editable && !renaming && (
          <>
            <button
              type="button"
              className="text-muted"
              aria-label={slider.pinned ? 'Unpin slider' : 'Pin slider'}
              aria-pressed={slider.pinned}
              onClick={() =>
                update({ pinned: !slider.pinned }, slider.pinned ? 'Unpin slider' : 'Pin slider')
              }
            >
              {slider.pinned ? '★' : '☆'}
            </button>
            <button
              type="button"
              className="text-muted"
              aria-label="Rename slider"
              onClick={() => setRenaming(true)}
            >
              ✎
            </button>
            <button
              type="button"
              className="text-muted"
              aria-label="Delete slider"
              onClick={() => apply([{ op: 'removeSlider', id: slider.id }], 'Delete slider')}
            >
              ×
            </button>
          </>
        )}
      </div>
      <input
        type="range"
        className="w-full accent-accent"
        min={slider.min}
        max={slider.max}
        step={slider.step}
        value={slider.value}
        disabled={!editable}
        aria-label={slider.label}
        onPointerDown={begin}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyUp={end}
        onKeyDown={begin}
        onChange={(e) => onValue(Number(e.target.value))}
      />
    </li>
  );
}

export function SliderTray() {
  const { can } = useEditor();
  const sliders = useDocStore((s) => s.doc.sliders);
  const readOnly = useDocStore((s) => s.readOnly);
  const [open, setOpen] = useState(true);
  if (!sliders.length) return null;
  const editable = can('design:edit') && !readOnly;
  const ordered = [...sliders].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  return (
    <section className="border-t border-border px-4 py-2" aria-label="Sliders">
      <button
        type="button"
        className="flex w-full items-center justify-between text-xs font-medium"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Sliders <span className="text-muted">{open ? '−' : `+${sliders.length}`}</span>
      </button>
      {open && (
        <ul className="mt-1 divide-y divide-border">
          {ordered.map((s) => (
            <SliderRow key={s.id} slider={s} editable={editable} />
          ))}
        </ul>
      )}
    </section>
  );
}
