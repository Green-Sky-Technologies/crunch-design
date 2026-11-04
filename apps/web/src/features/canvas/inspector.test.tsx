// @vitest-environment happy-dom
import { STYLE_PROP_NAMES } from '@crunch/doc-model';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { canvasStoreFor } from './canvas-store';
import { InspectorPane } from './index';
import { renderEditor } from './test-utils';

afterEach(cleanup);

const row = (prop: string) => document.querySelector<HTMLElement>(`[data-prop="${prop}"]`)!;
const field = (prop: string) =>
  row(prop).querySelector<HTMLInputElement | HTMLSelectElement>('input, select')!;

function setup(ids: string[] = ['n_herotitle1'], role: 'editor' | 'viewer' = 'editor') {
  const r = renderEditor(<InspectorPane />, { role });
  act(() => r.store().getState().select({ frameId: 'f_desktop001', nodeIds: ids }));
  return { ...r, node: (id = ids[0]!) => r.store().getState().doc.nodes[id]! };
}

describe('inspector (Story 3.3)', () => {
  it('lists every allowlisted StyleProp when filtered or expanded', () => {
    setup();
    // expand every group
    for (const b of screen.getAllByRole('button', { expanded: false })) fireEvent.click(b);
    for (const p of STYLE_PROP_NAMES) expect(row(p), p).toBeTruthy();
  });

  it('edits a literal at the frame breakpoint as one undo step, and shows provenance', () => {
    const { store, node } = setup();
    // the sample frame is 1280px wide: the lg breakpoint
    expect(screen.getByRole('tab', { name: 'lg •' }).getAttribute('aria-selected')).toBe('true');
    const input = field('letterSpacing') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2px' } });
    fireEvent.blur(input);
    expect(node().style.lg?.letterSpacing).toBe(2);
    expect(within(row('letterSpacing')).getByText('lg')).toBeTruthy();
    // base values show where they're inherited from
    expect(within(row('fontWeight')).getByText('↳ base')).toBeTruthy();
    expect(
      store()
        .getState()
        .undoStack.map((s) => s.label),
    ).toEqual(['Set letter spacing']);
  });

  it('rejects invalid input without applying it', () => {
    const { store } = setup();
    const input = field('letterSpacing') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'banana' } });
    fireEvent.blur(input);
    expect(store().getState().undoStack).toHaveLength(0);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('edits at another breakpoint and resets it', () => {
    const { node } = setup();
    fireEvent.click(screen.getByRole('tab', { name: 'base' }));
    const input = field('letterSpacing') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.blur(input);
    expect(node().style.base?.letterSpacing).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reset Letter spacing at base' }));
    expect(node().style.base?.letterSpacing).toBeUndefined();
  });

  it('picks a token filtered to the prop kinds', () => {
    const { node } = setup();
    fireEvent.click(within(row('color')).getByRole('button', { name: 'Text color token' }));
    const list = screen.getByRole('listbox', { name: 'Tokens' });
    const options = within(list).getAllByRole('option');
    expect(options.every((o) => o.textContent!.startsWith('color.'))).toBe(true);
    fireEvent.click(within(list).getByRole('button', { name: /^color\.accent/ }));
    expect(node().style.lg?.color).toEqual({ token: 'color.accent' });
    expect(within(row('color')).getByText(/color\.accent/)).toBeTruthy();
  });

  it('changes enums with a select', () => {
    const { node } = setup(['n_hero000001']);
    fireEvent.change(field('flexDirection'), { target: { value: 'row' } });
    expect(node().style.lg?.flexDirection).toBe('row');
  });

  it('coalesces arrow-key nudges into one undo step', () => {
    const { store, node } = setup();
    fireEvent.click(screen.getByRole('tab', { name: 'base' }));
    const input = field('letterSpacing') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp', shiftKey: true });
    expect(node().style.base?.letterSpacing).toBe(12);
    expect(store().getState().undoStack).toHaveLength(1);
  });

  it('applies to every selected node and shows mixed values', () => {
    const { node } = setup(['n_herotitle1', 'n_herobody01']);
    expect((field('fontSize') as HTMLElement).textContent).not.toContain('text.4xl');
    const input = field('letterSpacing') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.blur(input);
    expect(node('n_herotitle1').style.lg?.letterSpacing).toBe(3);
    expect(node('n_herobody01').style.lg?.letterSpacing).toBe(3);
    expect(screen.getByText('2 layers')).toBeTruthy();
  });

  it('renames layers and toggles positioning and visibility', () => {
    const { node } = setup();
    const name = screen.getByRole('textbox', { name: 'Layer name' });
    fireEvent.change(name, { target: { value: 'Title' } });
    fireEvent.blur(name);
    expect(node().name).toBe('Title');
    fireEvent.click(screen.getByRole('radio', { name: 'Absolute' }));
    expect(node().positioning).toBe('absolute');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hidden' }));
    expect(node().hidden).toBe(true);
  });

  it('is read-only for viewers', () => {
    setup(['n_herotitle1'], 'viewer');
    expect((field('letterSpacing') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Text color token' })).toBeNull();
  });

  it('shows the frame inspector when a frame is selected', () => {
    const { store } = renderEditor(<InspectorPane />);
    act(() => store().getState().select({ frameId: 'f_desktop001', nodeIds: [] }));
    const width = screen.getByRole('spinbutton', { name: 'Frame width' });
    fireEvent.change(width, { target: { value: '768' } });
    fireEvent.blur(width);
    expect(store().getState().doc.frames[0]!.width).toBe(768);
    expect(screen.getByText(/md breakpoint/)).toBeTruthy();
    // and the breakpoint override survives in the canvas store
    expect(canvasStoreFor(store()).getState().editBreakpoint).toBeNull();
  });
});
