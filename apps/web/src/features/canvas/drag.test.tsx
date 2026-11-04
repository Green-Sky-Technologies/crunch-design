// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { canvasStoreFor } from './canvas-store';
import { CanvasPane, InspectorPane } from './index';
import { fakeRect, frameRoot, renderEditor } from './test-utils';

afterEach(cleanup);

const node = (id: string) =>
  frameRoot('f_desktop001')!.querySelector<HTMLElement>(`[data-cd-id="${id}"]`)!;
const nextFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

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

function altDrag(
  el: HTMLElement,
  id: number,
  from: [number, number],
  to: [number, number],
  alt = true,
) {
  fireEvent.pointerDown(el, {
    button: 0,
    pointerId: id,
    clientX: from[0],
    clientY: from[1],
    altKey: alt,
  });
  // Cmd/Ctrl turns snapping off (happy-dom rects are all zero, so everything would snap).
  fireEvent.pointerMove(window, { pointerId: id, clientX: to[0], clientY: to[1], metaKey: true });
  fireEvent.pointerUp(window, { pointerId: id });
}

describe('drag (Story 3.4)', () => {
  it('Alt-drag makes a flow node absolute with base insets (every breakpoint), one undo step', async () => {
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
    // the frame renders at lg, but conversion writes base so md/base have a position too
    expect(n('n_herobody01').style.base).toMatchObject({ left: 100, top: 40 });
    expect(n('n_herobody01').style.lg?.left).toBeUndefined();
    expect(
      store()
        .getState()
        .undoStack.map((s) => s.label),
    ).toEqual(['Move layer']);
    act(() => store().getState().undo());
    expect(n('n_herobody01').positioning).toBe('flow');
  });

  it('absolute nodes then move at the frame breakpoint; Escape cancels', async () => {
    const { n, store } = await setup();
    const el = node('n_herobody01');
    altDrag(el, 1, [0, 0], [10, 10]);
    expect(n('n_herobody01').style.base).toMatchObject({ left: 20, top: 20 });
    altDrag(el, 2, [0, 0], [5, 0], false);
    expect(n('n_herobody01').style.lg).toMatchObject({ left: 10, top: 0 });

    fireEvent.pointerDown(el, { button: 0, pointerId: 3, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 30, clientY: 0 });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerUp(window, { pointerId: 3 });
    expect(el.style.translate).toBe('');
    expect(store().getState().undoStack).toHaveLength(2);
  });

  it('subtracts margins so placement does not drift', async () => {
    const { n } = await setup();
    const el = node('n_herobody01');
    el.style.marginLeft = '12px';
    el.style.marginTop = '8px';
    altDrag(el, 1, [0, 0], [50, 50]); // +100,+100 at zoom 0.5
    expect(n('n_herobody01').style.base).toMatchObject({ left: 88, top: 92 });
  });

  it('refuses free placement inside a scaled or rotated container, with a message', async () => {
    const { n, store } = await setup();
    node('n_hero000001').style.scale = '1.5';
    altDrag(node('n_herobody01'), 1, [0, 0], [50, 50]);
    expect(n('n_herobody01').positioning).toBe('flow');
    expect(canvasStoreFor(store()).getState().message).toMatch(/scaled or rotated/);
    expect(screen.getByRole('status').textContent).toMatch(/scaled or rotated/);
  });

  it('viewers never drag', async () => {
    const { store } = await setup('viewer');
    altDrag(node('n_herobody01'), 1, [0, 0], [50, 50]);
    expect(store().getState().doc.nodes['n_herobody01']!.positioning).toBe('flow');
    expect(canvasStoreFor(store()).getState().gesture).toBeNull();
  });

  it('the inspector toggle converts at base and restores the pinned width on return to flow', async () => {
    const { n } = await setup();
    fireEvent.pointerDown(node('n_herobody01'), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.click(screen.getByRole('radio', { name: 'Absolute' }));
    expect(n('n_herobody01').positioning).toBe('absolute');
    expect(n('n_herobody01').style.base).toMatchObject({ left: 0, top: 0 });
    expect(typeof n('n_herobody01').style.base?.width).toBe('number');
    fireEvent.click(screen.getByRole('radio', { name: 'Flow' }));
    expect(n('n_herobody01').positioning).toBe('flow');
    expect(n('n_herobody01').style.base?.left).toBeUndefined();
    expect(n('n_herobody01').style.base?.width).toBeUndefined(); // the pin is gone
  });
});

describe('breakpoint override scope (Story 3.3/3.5)', () => {
  it('is per frame, and canvas gestures always write the breakpoint the frame renders', async () => {
    const { store, n } = await setup();
    // pick md in the inspector for the desktop (lg) frame
    act(() =>
      store()
        .getState()
        .select({ frameId: 'f_desktop001', nodeIds: ['n_herocta001'] }),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'md' }));
    expect(screen.getByRole('tab', { name: 'md' }).getAttribute('aria-selected')).toBe('true');

    // a resize gesture still writes lg (what the frame shows)
    fakeRect(screen.getByTestId('canvas'), { x: 0, y: 0, width: 1200, height: 800 });
    fakeRect(node('n_herocta001'), { x: 100, y: 100, width: 60, height: 20 });
    await nextFrame();
    const e = screen.getByRole('slider', { name: 'Resize e' });
    fireEvent.pointerDown(e, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: 0, metaKey: true });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(n('n_herocta001').style.lg?.width).toBe(140);
    expect(n('n_herocta001').style.md?.width).toBeUndefined();

    // another frame ignores the desktop frame's override
    fireEvent.click(screen.getByRole('button', { name: '+ Frame' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Mobile/ }));
    const mobile = store().getState().doc.frames[1]!;
    act(() =>
      store()
        .getState()
        .select({ frameId: mobile.id, nodeIds: [mobile.rootNodeId] }),
    );
    expect(screen.getByRole('tab', { name: 'base •' }).getAttribute('aria-selected')).toBe('true');
  });
});
