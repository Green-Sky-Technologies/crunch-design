// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { canvasStoreFor } from './canvas-store';
import { CanvasPane, InspectorPane } from './index';
import { fakeRect, frameRoot, renderEditor } from './test-utils';

afterEach(cleanup);

const row = (prop: string) => document.querySelector<HTMLElement>(`[data-prop="${prop}"]`)!;
const node = (id: string) =>
  frameRoot('f_desktop001')!.querySelector<HTMLElement>(`[data-cd-id="${id}"]`)!;
const nextFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

async function setup(ids: string[], prep?: (s: ReturnType<typeof renderEditor>['store']) => void) {
  const r = renderEditor(
    <>
      <CanvasPane />
      <InspectorPane />
    </>,
  );
  await act(async () => {});
  if (prep) act(() => prep(r.store));
  act(() => r.store().getState().select({ frameId: 'f_desktop001', nodeIds: ids }));
  return { ...r, n: (id: string) => r.store().getState().doc.nodes[id]! };
}

describe('multi-selection compares every node (finding 6)', () => {
  it('applies a value equal to the primary node’s to the others', async () => {
    const { n } = await setup(['n_herotitle1', 'n_herobody01'], (store) =>
      store()
        .getState()
        .apply(
          [
            {
              op: 'setStyle',
              id: 'n_herotitle1',
              breakpoint: 'lg',
              prop: 'letterSpacing',
              value: 2,
            },
          ],
          { source: 'inspector' },
        ),
    );
    const input = row('letterSpacing').querySelector('input')!;
    fireEvent.change(input, { target: { value: '2' } });
    fireEvent.blur(input);
    expect(n('n_herobody01').style.lg?.letterSpacing).toBe(2);
  });

  it('offers reset when only a secondary node sets the prop, and resets it', async () => {
    const { n } = await setup(['n_herotitle1', 'n_herobody01'], (store) =>
      store()
        .getState()
        .apply(
          [
            {
              op: 'setStyle',
              id: 'n_herobody01',
              breakpoint: 'lg',
              prop: 'letterSpacing',
              value: 4,
            },
          ],
          { source: 'inspector' },
        ),
    );
    fireEvent.click(
      within(row('letterSpacing')).getByRole('button', { name: /Reset Letter spacing/ }),
    );
    expect(n('n_herobody01').style.lg?.letterSpacing).toBeUndefined();
  });

  it('converts the rest of a mixed selection when one node is already absolute', async () => {
    const { n } = await setup(['n_herotitle1', 'n_herobody01'], (store) =>
      store()
        .getState()
        .apply([{ op: 'setNodeMeta', id: 'n_herotitle1', patch: { positioning: 'absolute' } }], {
          source: 'canvas',
        }),
    );
    const abs = screen.getByRole('radio', { name: 'Absolute' });
    expect(abs.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(abs);
    expect(n('n_herobody01').positioning).toBe('absolute');
    expect(n('n_herotitle1').positioning).toBe('absolute');
  });
});

describe('locked layers are read-only everywhere (finding 11)', () => {
  const lockHero = (store: ReturnType<typeof renderEditor>['store']) =>
    store()
      .getState()
      .apply([{ op: 'setNodeMeta', id: 'n_hero000001', patch: { locked: true } }], {
        source: 'canvas',
      });

  it('can be selected (layers/keyboard) but not deleted, dragged, resized, restyled or text-edited', async () => {
    const { n, store } = await setup(['n_herotitle1'], lockHero);
    // keyboard delete is ignored
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(n('n_herotitle1')).toBeDefined();
    // inspector fields are disabled, with an explanation
    expect(screen.getByText(/Locked layers can.t be edited/)).toBeTruthy();
    expect((row('letterSpacing').querySelector('input') as HTMLInputElement).disabled).toBe(true);
    // no resize handles
    fakeRect(screen.getByTestId('canvas'), { x: 0, y: 0, width: 1000, height: 800 });
    fakeRect(node('n_herotitle1'), { x: 10, y: 10, width: 50, height: 20 });
    await nextFrame();
    expect(document.querySelectorAll('[data-handle]')).toHaveLength(0);
    // no drag (with a message)
    fireEvent.pointerDown(node('n_herotitle1'), { button: 0, pointerId: 1, altKey: true });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 80, clientY: 80, metaKey: true });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(n('n_herotitle1').positioning).toBe('flow');
    expect(canvasStoreFor(store()).getState().message).toMatch(/Locked layers/);
    // no inline text editing
    act(() =>
      store()
        .getState()
        .select({ frameId: 'f_desktop001', nodeIds: ['n_herotitle1'] }),
    );
    fireEvent.dblClick(node('n_herotitle1'));
    expect(node('n_herotitle1').hasAttribute('contenteditable')).toBe(false);
  });

  it('can be unlocked from the inspector, after which edits work again', async () => {
    const { n } = await setup(['n_hero000001'], lockHero);
    const locked = screen.getByRole('checkbox', { name: 'Locked' });
    expect((locked as HTMLInputElement).checked).toBe(true);
    fireEvent.click(locked);
    expect(n('n_hero000001').locked).toBeUndefined();
    expect((row('letterSpacing').querySelector('input') as HTMLInputElement).disabled).toBe(false);
  });
});
