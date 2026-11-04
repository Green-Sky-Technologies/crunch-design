// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { canvasStoreFor } from './canvas-store';
import { CanvasPane, InspectorPane } from './index';
import { fakeRect, frameRoot, renderEditor } from './test-utils';

afterEach(cleanup);

const node = (id: string) =>
  frameRoot('f_desktop001')!.querySelector<HTMLElement>(`[data-cd-id="${id}"]`)!;
const nextFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

async function setup(id = 'n_herocta001', role: 'editor' | 'viewer' = 'editor') {
  const r = renderEditor(
    <>
      <CanvasPane />
      <InspectorPane />
    </>,
    { role },
  );
  await act(async () => {});
  act(() => canvasStoreFor(r.store()).getState().setCamera({ x: 0, y: 0, z: 0.5 }));
  fakeRect(screen.getByTestId('canvas'), { x: 0, y: 0, width: 1200, height: 800 });
  fakeRect(node(id), { x: 100, y: 100, width: 60, height: 20 }); // world 200,200 120x40
  act(() =>
    r
      .store()
      .getState()
      .select({ frameId: 'f_desktop001', nodeIds: [id] }),
  );
  await nextFrame();
  return { ...r, style: () => r.store().getState().doc.nodes[id]!.style };
}

describe('resize (Story 3.5)', () => {
  it('flow nodes get east/south handles; dragging commits a fixed size in one step', async () => {
    const { style, store } = await setup();
    expect(
      [...document.querySelectorAll('[data-handle]')].map((h) => h.getAttribute('data-handle')),
    ).toEqual(['e', 'se', 's']);
    const se = screen.getByRole('slider', { name: 'Resize se' });
    fireEvent.pointerDown(se, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 10, metaKey: true });
    // live preview on the element, nothing in the doc yet
    expect(node('n_herocta001').style.getPropertyValue('width')).toBe('160px');
    expect(style().lg?.width).toBeUndefined();
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(style().lg).toMatchObject({ width: 160, height: 60 });
    expect(node('n_herocta001').style.getPropertyValue('width')).toBe('');
    expect(
      store()
        .getState()
        .undoStack.map((s) => s.label),
    ).toEqual(['Resize layer']);
  });

  it('double-clicking a handle hugs content on that axis', async () => {
    const { style } = await setup();
    fireEvent.doubleClick(screen.getByRole('slider', { name: 'Resize e' }));
    expect(style().lg?.width).toBe('hug');
    fireEvent.doubleClick(screen.getByRole('slider', { name: 'Resize se' }));
    expect(style().lg).toMatchObject({ width: 'hug', height: 'hug' });
  });

  it('the inspector switches fixed, fill and hug', async () => {
    const { style } = await setup('n_herobody01');
    const width = screen.getByRole('radiogroup', { name: 'width sizing' });
    fireEvent.click(within(width).getByRole('radio', { name: 'fill' }));
    expect(style().lg?.width).toBe('fill');
    fireEvent.click(within(width).getByRole('radio', { name: 'hug' }));
    expect(style().lg?.width).toBe('hug');
    fireEvent.click(within(width).getByRole('radio', { name: 'fixed' }));
    expect(typeof style().lg?.width).toBe('number');
    expect(within(width).getByRole('radio', { name: 'fixed' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('absolute nodes get all handles and resizing from the west moves left', async () => {
    const r = renderEditor(<CanvasPane />);
    await act(async () => {});
    act(() => {
      r.store()
        .getState()
        .apply(
          [
            { op: 'setNodeMeta', id: 'n_herobody01', patch: { positioning: 'absolute' } },
            { op: 'setStyle', id: 'n_herobody01', breakpoint: 'lg', prop: 'left', value: 0 },
          ],
          { source: 'canvas' },
        );
      canvasStoreFor(r.store()).getState().setCamera({ x: 0, y: 0, z: 1 });
      r.store()
        .getState()
        .select({ frameId: 'f_desktop001', nodeIds: ['n_herobody01'] });
    });
    fakeRect(screen.getByTestId('canvas'), { x: 0, y: 0, width: 1200, height: 800 });
    fakeRect(node('n_herobody01'), { x: 100, y: 100, width: 200, height: 20 });
    await nextFrame();
    expect(document.querySelectorAll('[data-handle]')).toHaveLength(8);
    const w = screen.getByRole('slider', { name: 'Resize w' });
    fireEvent.pointerDown(w, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 50, clientY: 0, ctrlKey: true });
    fireEvent.pointerUp(window, { pointerId: 1 });
    const s = r.store().getState().doc.nodes['n_herobody01']!.style.lg;
    expect(s).toMatchObject({ width: 150, left: 50 });
  });

  it('viewers get no handles', async () => {
    await setup('n_herocta001', 'viewer');
    expect(document.querySelectorAll('[data-handle]')).toHaveLength(0);
  });
});
