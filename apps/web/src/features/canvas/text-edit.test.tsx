// @vitest-environment happy-dom
import { starterDesignSystem } from '@crunch/doc-model';
import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { canvasStoreFor } from './canvas-store';
import { CanvasPane } from './index';
import { frameRoot, renderEditor } from './test-utils';
import { readEditedText, textTargetFor } from './text-edit';

afterEach(cleanup);

const node = (id: string) =>
  frameRoot('f_desktop001')!.querySelector<HTMLElement>(`[data-cd-id="${id}"]`)!;

async function setup(role: 'editor' | 'viewer' = 'editor') {
  const r = renderEditor(<CanvasPane />, { role, mode: 'edit' });
  await act(async () => {});
  return {
    ...r,
    text: (id: string) =>
      (r.store().getState().doc.nodes[id] as { props: { text: string } }).props.text,
  };
}

function type(el: HTMLElement, text: string) {
  el.textContent = text;
}

describe('inline text editing (Story 3.6)', () => {
  it('double-click edits in place; Enter commits one op', async () => {
    const { text, store } = await setup();
    const el = node('n_herotitle1');
    fireEvent.dblClick(el);
    expect(el.getAttribute('contenteditable')).toMatch(/plaintext-only|true/);
    expect(canvasStoreFor(store()).getState().gesture).toBe('text');
    type(el, 'Hello 👋🏽 世界');
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(el.hasAttribute('contenteditable')).toBe(false);
    expect(text('n_herotitle1')).toBe('Hello 👋🏽 世界');
    expect(
      store()
        .getState()
        .undoStack.map((s) => s.label),
    ).toEqual(['Edit text']);
    await act(async () => {});
    expect(el.textContent).toBe('Hello 👋🏽 世界');
  });

  it('Esc cancels and restores the original text', async () => {
    const { text, store } = await setup();
    const el = node('n_herobody01');
    const before = text('n_herobody01');
    fireEvent.dblClick(el);
    type(el, 'nope');
    fireEvent.keyDown(el, { key: 'Escape' });
    expect(el.textContent).toBe(before);
    expect(text('n_herobody01')).toBe(before);
    expect(store().getState().undoStack).toHaveLength(0);
  });

  it('ignores Enter while an IME composition is active, and commits on blur', async () => {
    const { text } = await setup();
    const el = node('n_herotitle1');
    fireEvent.dblClick(el);
    fireEvent.compositionStart(el);
    type(el, 'にほん');
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(el.hasAttribute('contenteditable')).toBe(true);
    fireEvent.compositionEnd(el);
    type(el, '日本');
    fireEvent.blur(el);
    expect(text('n_herotitle1')).toBe('日本');
  });

  it('keeps keys inside the editor and blocks rich formatting shortcuts', async () => {
    const { store } = await setup();
    const el = node('n_herotitle1');
    act(() =>
      store()
        .getState()
        .select({ frameId: 'f_desktop001', nodeIds: ['n_herotitle1'] }),
    );
    fireEvent.dblClick(el);
    let reachedWindow = false;
    const spy = () => (reachedWindow = true);
    window.addEventListener('keydown', spy);
    fireEvent.keyDown(el, { key: 'Delete' });
    const bold = fireEvent.keyDown(el, { key: 'b', metaKey: true });
    window.removeEventListener('keydown', spy);
    expect(reachedWindow).toBe(false);
    expect(bold).toBe(false); // default prevented
    expect(store().getState().doc.nodes['n_herotitle1']).toBeDefined();
  });

  it('Enter on a selected text node starts editing', async () => {
    const { store } = await setup();
    act(() =>
      store()
        .getState()
        .select({ frameId: 'f_desktop001', nodeIds: ['n_herobody01'] }),
    );
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(node('n_herobody01').hasAttribute('contenteditable')).toBe(true);
  });

  it('viewers cannot edit text', async () => {
    await setup('viewer');
    const el = node('n_herotitle1');
    fireEvent.dblClick(el);
    expect(el.hasAttribute('contenteditable')).toBe(false);
  });

  it('reads line breaks and strips browser padding', () => {
    const div = document.createElement('div');
    div.innerHTML = 'one<br>two <br>';
    expect(readEditedText(div)).toBe('one\ntwo ');
  });

  it('targets the bound prop for text inside a component instance', async () => {
    const { store } = await setup();
    const doc = store().getState().doc;
    const ds = starterDesignSystem();
    expect(textTargetFor(doc, ds, 'f_desktop001', 'n_herocta001', 'n_btnlabel1')).toEqual({
      frameId: 'f_desktop001',
      nodeId: 'n_herocta001',
      partId: 'n_btnlabel1',
      bind: 'label',
    });
    expect(textTargetFor(doc, ds, 'f_desktop001', 'n_herocta001', 'n_btnroot01')).toBeNull();
    expect(textTargetFor(doc, ds, 'f_desktop001', 'n_hero000001')).toBeNull();
  });
});
