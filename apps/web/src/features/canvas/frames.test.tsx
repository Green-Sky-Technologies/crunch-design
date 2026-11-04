// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { canvasStoreFor } from './canvas-store';
import { CanvasPane } from './index';
import { frameRoot, renderEditor } from './test-utils';

afterEach(cleanup);

const label = (id: string) => document.querySelector(`[data-cd-frame-label="${id}"]`)!;
const FRAME = 'f_desktop001';

describe('canvas frames (Story 3.1)', () => {
  it('renders every frame as live DOM in the world layer', async () => {
    renderEditor(<CanvasPane />);
    await act(async () => {});
    expect(frameRoot(FRAME)?.textContent).toContain('Ship designs your engineers can build.');
    expect(label(FRAME).textContent).toBe('Landing — Desktop');
  });

  it('adds, duplicates, renames and deletes frames as undoable ops', async () => {
    const { store } = renderEditor(<CanvasPane />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '+ Frame' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Mobile/ }));
    let frames = store().getState().doc.frames;
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({ name: 'Mobile', width: 390 });
    expect(store().getState().selection.frameId).toBe(frames[1]!.id);

    // the selected frame shows its actions
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    frames = store().getState().doc.frames;
    expect(frames.map((f) => f.name)).toEqual(['Landing — Desktop', 'Mobile', 'Mobile copy']);

    // rename by double-clicking the label
    const dupId = frames[2]!.id;
    fireEvent.doubleClick(label(dupId));
    const input = screen.getByRole('textbox', { name: 'Frame name' });
    fireEvent.change(input, { target: { value: 'Phone' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(store().getState().doc.frames[2]!.name).toBe('Phone');

    fireEvent.pointerDown(label(dupId), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(store().getState().doc.frames).toHaveLength(2);

    // each action was exactly one undo step
    expect(
      store()
        .getState()
        .undoStack.map((s) => s.label),
    ).toEqual(['Add frame', 'Duplicate frame', 'Rename frame', 'Delete frame']);
    act(() => store().getState().undo());
    expect(
      store()
        .getState()
        .doc.frames.map((f) => f.name),
    ).toContain('Phone');
  });

  it('moves a frame by dragging its label, committing a single op on release', async () => {
    const { store } = renderEditor(<CanvasPane />);
    await act(async () => {});
    const canvas = canvasStoreFor(store());
    act(() => canvas.getState().setCamera({ x: 0, y: 0, z: 0.5 }));
    fireEvent.pointerDown(label(FRAME), { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 60, clientY: 30 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 110, clientY: 60 });
    // previewed, not yet in the doc
    expect(canvas.getState().framePreview).toMatchObject({ dx: 200, dy: 100 });
    expect(store().getState().doc.frames[0]!.canvas).toEqual({ x: 0, y: 0 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(store().getState().doc.frames[0]!.canvas).toEqual({ x: 200, y: 100 });
    expect(store().getState().undoStack).toHaveLength(1);
  });

  it('resizes a frame width with the handle, and Escape cancels a gesture', async () => {
    const { store } = renderEditor(<CanvasPane />);
    await act(async () => {});
    const canvas = canvasStoreFor(store());
    act(() => canvas.getState().setCamera({ x: 0, y: 0, z: 1 }));
    fireEvent.pointerDown(label(FRAME), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    const handle = screen.getByRole('slider', { name: 'Frame width' });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 0 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: -500 });
    fireEvent.pointerUp(window, { pointerId: 2 });
    expect(store().getState().doc.frames[0]!.width).toBe(780);

    fireEvent.pointerDown(handle, { button: 0, pointerId: 3, clientX: 0 });
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 300 });
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerUp(window, { pointerId: 3 });
    expect(store().getState().doc.frames[0]!.width).toBe(780);
    expect(canvas.getState().framePreview).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Frame size' }), {
      target: { value: '390' },
    });
    expect(store().getState().doc.frames[0]!.width).toBe(390);
  });

  it('zooms with ctrl+wheel and the toolbar, and pans with the wheel', async () => {
    const { store } = renderEditor(<CanvasPane />);
    await act(async () => {});
    const canvas = canvasStoreFor(store());
    act(() => canvas.getState().setCamera({ x: 0, y: 0, z: 1 }));
    const viewport = screen.getByTestId('canvas');
    act(() => {
      viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, deltaX: 10, bubbles: true }));
    });
    expect(canvas.getState().camera).toMatchObject({ x: -10, y: -40, z: 1 });
    // happy-dom's WheelEvent has no modifier keys; real browsers set ctrlKey for pinch too.
    const pinch = new WheelEvent('wheel', { deltaY: -50, bubbles: true });
    Object.defineProperty(pinch, 'ctrlKey', { value: true });
    act(() => void viewport.dispatchEvent(pinch));
    expect(canvas.getState().camera.z).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom to 100%' }));
    expect(screen.getByTestId('zoom-level').textContent).toBe('100%');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(screen.getByTestId('zoom-level').textContent).toBe('75%');
    // the world layer follows the camera without re-rendering frames
    const world = document.querySelector<HTMLElement>('[data-cd-world]')!;
    expect(world.style.transform).toContain('scale(0.75)');
  });

  it('is read-only for viewers: no frame actions or handles', async () => {
    renderEditor(<CanvasPane />, { role: 'viewer' });
    await act(async () => {});
    fireEvent.pointerDown(label(FRAME), { button: 0, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(screen.queryByRole('button', { name: '+ Frame' })).toBeNull();
    expect(screen.queryByRole('slider', { name: 'Frame width' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});
