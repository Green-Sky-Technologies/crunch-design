// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canvasStoreFor } from './canvas-store';
import { CanvasPane, EditPanel } from './index';
import { fakeRect, frameRoot, renderEditor } from './test-utils';

const node = (id: string) =>
  frameRoot('f_desktop001')!.querySelector<HTMLElement>(`[data-cd-id="${id}"]`)!;
const nextFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function setup(ids: string[]) {
  const r = renderEditor(
    <>
      <CanvasPane />
      <EditPanel />
    </>,
    { mode: 'edit' },
  );
  await act(async () => {});
  act(() => r.store().getState().select({ frameId: 'f_desktop001', nodeIds: ids }));
  fireEvent.click(screen.getByRole('tab', { name: 'Pro' }));
  return { ...r, style: (id = ids[0]!) => r.store().getState().doc.nodes[id]!.style };
}

describe('one undo step per gesture (finding 7)', () => {
  it('a scrub held still for longer than the coalesce window is still one step', async () => {
    const { style, store } = await setup(['n_herotitle1']);
    const label = within(document.querySelector<HTMLElement>('[data-prop="blur"]')!).getByText(
      'Blur',
    );
    fireEvent.pointerDown(label, { button: 0, pointerId: 1, clientX: 0 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 10 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000); // held still for 2s
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 20 });
    // previewed on the element, not yet in the doc
    expect(node('n_herotitle1').style.getPropertyValue('filter')).toBe('blur(10px)');
    expect(style().lg?.blur).toBeUndefined();
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(style().lg?.blur).toBe(10);
    expect(node('n_herotitle1').style.getPropertyValue('filter')).toBe('');
    expect(
      store()
        .getState()
        .undoStack.map((s) => s.label),
    ).toEqual(['Set blur']);
  });
});

describe('aspect lock on side handles (finding 9)', () => {
  it('Shift on the east handle changes height in proportion', async () => {
    const { style, store } = await setup(['n_herocta001']);
    act(() => canvasStoreFor(store()).getState().setCamera({ x: 0, y: 0, z: 1 }));
    fakeRect(screen.getByTestId('canvas'), { x: 0, y: 0, width: 1200, height: 800 });
    fakeRect(node('n_herocta001'), { x: 100, y: 100, width: 100, height: 40 });
    await nextFrame();
    const e = screen.getByRole('slider', { name: 'Resize e' });
    fireEvent.pointerDown(e, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: 100,
      clientY: 0,
      shiftKey: true,
      metaKey: true,
    });
    expect(node('n_herocta001').style.getPropertyValue('height')).toBe('80px');
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(style().lg).toMatchObject({ width: 200, height: 80 });
  });
});

describe('plain-text drops and rich input (finding 12)', () => {
  it('drops insert plain text only and rich beforeinput is blocked', async () => {
    const { store } = await setup(['n_herotitle1']);
    const el = node('n_herotitle1');
    fireEvent.dblClick(el);
    expect(el.hasAttribute('contenteditable')).toBe(true);
    // fallback mode (no plaintext-only) is the risky one: force it
    el.contentEditable = 'true';
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        getData: (t: string) => (t === 'text/plain' ? ' dropped' : '<b>rich</b>'),
      },
    });
    el.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(el.innerHTML).not.toContain('<b>');
    expect(el.textContent).toContain('dropped');

    const bold = new Event('beforeinput', { bubbles: true, cancelable: true });
    Object.defineProperty(bold, 'inputType', { value: 'formatBold' });
    el.dispatchEvent(bold);
    expect(bold.defaultPrevented).toBe(true);
    const typing = new Event('beforeinput', { bubbles: true, cancelable: true });
    Object.defineProperty(typing, 'inputType', { value: 'insertText' });
    el.dispatchEvent(typing);
    expect(typing.defaultPrevented).toBe(false);

    fireEvent.keyDown(el, { key: 'Enter' });
    const text = (store().getState().doc.nodes['n_herotitle1'] as { props: { text: string } }).props
      .text;
    expect(text).toContain('dropped');
    expect(text).not.toContain('<b>');
  });
});
