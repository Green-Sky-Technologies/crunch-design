// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { canvasStoreFor } from './canvas-store';
import { CanvasPane, InspectorPane } from './index';
import { frameRoot, renderEditor } from './test-utils';

afterEach(cleanup);

const node = (id: string) =>
  frameRoot('f_desktop001')!.querySelector<HTMLElement>(`[data-cd-id="${id}"]`)!;

async function setup(role: 'editor' | 'viewer' = 'editor') {
  const r = renderEditor(
    <>
      <CanvasPane />
      <InspectorPane />
    </>,
    { role },
  );
  await act(async () => {});
  act(() => canvasStoreFor(r.store()).getState().setCamera({ x: 0, y: 0, z: 0.5 }));
  return { ...r, n: (id: string) => r.store().getState().doc.nodes[id]! };
}

describe('drag (Story 3.4)', () => {
  it('Alt-drag places a flow node absolutely, as one undo step', async () => {
    const { n, store } = await setup();
    const el = node('n_herobody01');
    fireEvent.pointerDown(el, {
      button: 0,
      pointerId: 1,
      clientX: 100,
      clientY: 100,
      altKey: true,
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 150, clientY: 120 });
    // previewed with an inline translate, the doc is untouched until release
    expect(el.style.translate).toBe('100px 40px');
    expect(n('n_herobody01').positioning).toBe('flow');
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(el.style.translate).toBe('');
    expect(n('n_herobody01').positioning).toBe('absolute');
    expect(n('n_herobody01').style.lg).toMatchObject({ left: 100, top: 40 });
    expect(
      store()
        .getState()
        .undoStack.map((s) => s.label),
    ).toEqual(['Move layer']);
    act(() => store().getState().undo());
    expect(n('n_herobody01').positioning).toBe('flow');
  });

  it('absolute nodes move freely without Alt; Escape cancels', async () => {
    const { n, store } = await setup();
    const el = node('n_herobody01');
    fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientX: 0, clientY: 0, altKey: true });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(n('n_herobody01').style.lg).toMatchObject({ left: 20, top: 20 });

    fireEvent.pointerDown(el, { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 30, clientY: 0 });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerUp(window, { pointerId: 2 });
    expect(el.style.translate).toBe('');
    expect(store().getState().undoStack).toHaveLength(1);
  });

  it('frame roots and viewers never drag', async () => {
    const { store } = await setup('viewer');
    fireEvent.pointerDown(node('n_herobody01'), { button: 0, pointerId: 1, altKey: true });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(store().getState().doc.nodes['n_herobody01']!.positioning).toBe('flow');
    expect(canvasStoreFor(store()).getState().gesture).toBeNull();
  });

  it('the inspector toggle switches between absolute and flow', async () => {
    const { n } = await setup();
    fireEvent.pointerDown(node('n_herobody01'), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.click(screen.getByRole('radio', { name: 'Absolute' }));
    expect(n('n_herobody01').positioning).toBe('absolute');
    expect(n('n_herobody01').style.lg).toMatchObject({ left: 0, top: 0 });
    fireEvent.click(screen.getByRole('radio', { name: 'Flow' }));
    expect(n('n_herobody01').positioning).toBe('flow');
    expect(n('n_herobody01').style.lg?.left).toBeUndefined();
  });
});
