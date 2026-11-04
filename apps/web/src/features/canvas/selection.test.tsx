// @vitest-environment happy-dom
import { registerOverlay, type OverlayApi } from '@crunch/contracts/canvas-overlay';
import { act, cleanup, createEvent, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { canvasStoreFor } from './canvas-store';
import { CanvasPane, EditPanel } from './index';
import { fakeRect, frameRoot, renderEditor } from './test-utils';

afterEach(cleanup);

const FRAME = 'f_desktop001';
const node = (id: string) => frameRoot(FRAME)!.querySelector<HTMLElement>(`[data-cd-id="${id}"]`)!;
/** A real click: press and release (an unreleased press is a pending drag). */
const press = (el: HTMLElement, shiftKey = false) => {
  fireEvent.pointerDown(el, { button: 0, shiftKey, pointerId: 1 });
  fireEvent.pointerUp(window, { pointerId: 1 });
};
const nextFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

async function setup(role: 'editor' | 'viewer' = 'editor') {
  const r = renderEditor(
    <>
      <CanvasPane />
      <EditPanel />
    </>,
    { role, mode: 'edit' },
  );
  await act(async () => {});
  return { ...r, sel: () => r.store().getState().selection };
}

describe('selection (Story 3.2)', () => {
  it('selects the clicked node inside a frame; Shift adds; instances are one node', async () => {
    const { sel } = await setup();
    press(node('n_herotitle1'));
    expect(sel()).toEqual({ frameId: FRAME, nodeIds: ['n_herotitle1'] });
    // a click on a part of a Button instance selects the instance
    const part = node('n_herocta001').querySelector('[data-cd-part]') as HTMLElement;
    press(part ?? node('n_herocta001'), true);
    expect(sel().nodeIds).toEqual(['n_herotitle1', 'n_herocta001']);
    press(node('n_herotitle1'), true);
    expect(sel().nodeIds).toEqual(['n_herocta001']);
  });

  it('navigates the tree with Esc, Enter and Tab, and deletes with Delete', async () => {
    const { sel, store } = await setup();
    press(node('n_herotitle1'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(sel().nodeIds).toEqual(['n_hero000001']);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(sel().nodeIds).toEqual(['n_herotitle1']);
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(sel().nodeIds).toEqual(['n_herobody01']);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(sel().nodeIds).toEqual(['n_herotitle1']);
    // Esc up to the frame root, then the frame, then nothing
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(sel().nodeIds).toEqual(['n_root000001']);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(sel()).toEqual({ frameId: FRAME, nodeIds: [] });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(sel()).toEqual({ frameId: null, nodeIds: [] });

    press(node('n_herobody01'));
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(store().getState().doc.nodes['n_herobody01']).toBeUndefined();
    expect(sel().nodeIds).toEqual(['n_hero000001']);
    act(() => store().getState().undo());
    expect(store().getState().doc.nodes['n_herobody01']).toBeDefined();
  });

  it('viewers can’t enter edit mode, so the canvas never selects or deletes', async () => {
    const { sel, store, canvas } = await setup('viewer');
    expect(canvas().getState().mode).toBe('view');
    press(node('n_herobody01'));
    expect(sel().nodeIds).toEqual([]);
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(store().getState().doc.nodes['n_herobody01']).toBeDefined();
    expect(screen.getByTestId('edit-panel').textContent).toMatch(/view access/);
  });

  it('draws outlines at the node rect projected by the camera', async () => {
    const { store } = await setup();
    const canvas = canvasStoreFor(store());
    act(() => canvas.getState().setCamera({ x: 10, y: 20, z: 2 }));
    fakeRect(screen.getByTestId('canvas'), { x: 0, y: 0, width: 1000, height: 800 });
    // world rect = (screen - camera) / z = (110-10)/2, (220-20)/2 -> 50,100 size 40x15
    fakeRect(node('n_herotitle1'), { x: 110, y: 220, width: 80, height: 30 });
    press(node('n_herotitle1'));
    await nextFrame();
    const box = document.querySelector('[data-cd-selected="n_herotitle1"]')!.parentElement!;
    expect([box.style.left, box.style.top, box.style.width]).toEqual(['110px', '220px', '80px']);
    expect(screen.getByTestId('selection-size').textContent).toBe('40 × 15');
    // zooming re-projects without re-measuring
    act(() => canvas.getState().setCamera({ x: 0, y: 0, z: 1 }));
    expect([box.style.left, box.style.top, box.style.width]).toEqual(['50px', '100px', '40px']);
  });

  it('the layer tree mirrors the tree, selects, reveals the selection and hides layers', async () => {
    const { sel, store } = await setup();
    const tree = screen.getByRole('tree', { name: 'Landing — Desktop layers' });
    // root expanded by default: its children are listed with semantic names
    const hero = within(tree).getByRole('button', { name: 'Column Hero' });
    expect(within(tree).queryByRole('button', { name: /^Headline/ })).toBeNull();
    // the tag is shown right-aligned
    expect(hero.closest('li')!.textContent).toContain('section');
    fireEvent.click(hero);
    expect(sel().nodeIds).toEqual(['n_hero000001']);
    // selecting on the canvas expands the ancestors in the tree
    press(node('n_feat2title0'));
    const row = within(tree).getByRole('button', { name: 'Heading “Your design system”' });
    expect(row.closest('li')!.getAttribute('aria-selected')).toBe('true');
    // hovering a row highlights the node on the canvas
    fireEvent.pointerEnter(row.closest('li')!);
    expect(canvasStoreFor(store()).getState().hover).toEqual({
      frameId: FRAME,
      nodeId: 'n_feat2title0',
    });
    press(node('n_herotitle1'));
    fireEvent.click(within(tree).getByRole('button', { name: 'Hide Headline' }));
    expect(store().getState().doc.nodes['n_herotitle1']!.hidden).toBe(true);
    // no floating layers panel on the canvas any more
    expect(within(screen.getByTestId('canvas')).queryByRole('tree')).toBeNull();
  });

  it('drags a layer row to reorder it (one moveNode op)', async () => {
    const { store } = await setup();
    const tree = screen.getByRole('tree', { name: 'Landing — Desktop layers' });
    const features = within(tree).getByRole('button', { name: 'Grid Features' }).closest('li')!;
    const nav = within(tree).getByRole('button', { name: 'Row Nav' }).closest('li')!;
    fakeRect(nav, { x: 0, y: 0, width: 300, height: 28 });
    fireEvent.dragStart(features);
    const over = createEvent.dragOver(nav);
    Object.defineProperty(over, 'clientY', { value: 2 }); // top quarter: before Nav
    fireEvent(nav, over);
    fireEvent.drop(nav);
    expect(store().getState().doc.nodes['n_root000001']!.children[0]).toBe('n_features01');
    expect(
      store()
        .getState()
        .undoStack.map((u) => u.label),
    ).toEqual(['Move layer']);
  });
});

describe('canvas-overlay contract', () => {
  it('renders registered overlays with a working OverlayApi', async () => {
    let api!: OverlayApi;
    const unregister = registerOverlay({
      id: 'test-pins',
      Component: ({ api: a }) => {
        api = a;
        return <div data-testid="pin">pin</div>;
      },
    });
    const { store } = await setup();
    expect(screen.getByTestId('pin').closest('[data-cd-overlay]')).toBeTruthy();
    expect(api.projectId).toBe('00000000-0000-4000-8000-000000000001');
    expect(api.readOnly).toBe(false);

    const canvas = canvasStoreFor(store());
    act(() => canvas.getState().setCamera({ x: 100, y: 50, z: 0.5 }));
    expect(api.zoom).toBe(0.5);
    expect(api.canvasToOverlay({ x: 200, y: 100 })).toEqual({ x: 200, y: 100 });

    fakeRect(screen.getByTestId('canvas'), { x: 20, y: 30, width: 1000, height: 800 });
    fakeRect(node('n_herobody01'), { x: 120, y: 130, width: 50, height: 10 });
    expect(api.getNodeRect('n_herobody01')).toEqual({ x: 100, y: 100, width: 50, height: 10 });
    expect(api.getNodeRect('n_herobody01', FRAME)).toEqual({
      x: 100,
      y: 100,
      width: 50,
      height: 10,
    });
    expect(api.getNodeRect('n_missing000')).toBeNull();

    let calls = 0;
    const off = api.subscribe(() => calls++);
    act(() => canvas.getState().setCamera({ x: 0, y: 0, z: 1 }));
    expect(calls).toBe(1);
    off();
    act(() => canvas.getState().setCamera({ x: 1, y: 0, z: 1 }));
    expect(calls).toBe(1);

    act(() => unregister());
    expect(screen.queryByTestId('pin')).toBeNull();
  });
});
