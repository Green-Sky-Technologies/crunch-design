// @vitest-environment happy-dom
import { STYLE_PROP_NAMES, type DocOp } from '@crunch/doc-model';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CanvasPane, EditPanel } from './index';
import { frameRoot, renderEditor } from './test-utils';

afterEach(cleanup);

const FRAME = 'f_desktop001';
const row = (prop: string) => document.querySelector<HTMLElement>(`[data-prop="${prop}"]`)!;
const field = (prop: string) =>
  row(prop).querySelector<HTMLInputElement | HTMLSelectElement>('input:not([type=color]), select')!;
const node = (id: string) => frameRoot(FRAME)!.querySelector<HTMLElement>(`[data-cd-id="${id}"]`)!;
/** A real click: press and release (an unreleased press is a pending drag). */
const press = (el: HTMLElement, init: Partial<PointerEventInit> = {}) => {
  fireEvent.pointerDown(el, { button: 0, pointerId: 1, ...init });
  fireEvent.pointerUp(window, { pointerId: 1 });
};
const setText = (input: HTMLElement, value: string) => {
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
};

async function setup(
  opts: { ids?: string[]; tab?: 'Simple' | 'Pro' | 'Code' | 'Tweaks'; mode?: 'view' | 'edit' } = {},
) {
  const r = renderEditor(
    <>
      <CanvasPane />
      <EditPanel />
    </>,
    { mode: opts.mode ?? 'edit' },
  );
  await act(async () => {});
  if (opts.ids) act(() => r.store().getState().select({ frameId: FRAME, nodeIds: opts.ids! }));
  if (opts.tab) fireEvent.click(screen.getByRole('tab', { name: opts.tab }));
  return {
    ...r,
    n: (id = opts.ids?.[0] ?? '') => r.store().getState().doc.nodes[id]!,
    labels: () =>
      r
        .store()
        .getState()
        .undoStack.map((s) => s.label),
  };
}

describe('mode gating', () => {
  it('view mode is a preview: no selection, hover, keys or handles; pan still works', async () => {
    const { store, canvas } = await setup({ mode: 'view' });
    press(node('n_herotitle1'));
    expect(store().getState().selection.nodeIds).toEqual([]);
    fireEvent.pointerMove(node('n_herotitle1'), { pointerId: 1 });
    expect(canvas().getState().hover).toBeNull();
    act(() =>
      store()
        .getState()
        .select({ frameId: FRAME, nodeIds: ['n_herobody01'] }),
    );
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(store().getState().doc.nodes['n_herobody01']).toBeDefined();
    expect(document.querySelector('[data-cd-selected]')).toBeNull();
    expect(document.querySelectorAll('[data-handle]')).toHaveLength(0);
    // frame labels stay visible but can't be dragged
    const label = document.querySelector<HTMLElement>(`[data-cd-frame-label="${FRAME}"]`)!;
    expect(label.textContent).toBe('Landing — Desktop');
    fireEvent.pointerDown(label, { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 80, clientY: 0 });
    fireEvent.pointerUp(window, { pointerId: 2 });
    expect(store().getState().doc.frames[0]!.canvas.x).toBe(0);
    // the wheel still pans
    const before = canvas().getState().camera;
    fireEvent.wheel(screen.getByTestId('canvas'), { deltaX: 0, deltaY: 40 });
    expect(canvas().getState().camera).not.toEqual(before);
  });

  it('edit mode selects; leaving it clears the selection and the tool', async () => {
    const { store, canvas } = await setup();
    press(node('n_herotitle1'));
    expect(store().getState().selection.nodeIds).toEqual(['n_herotitle1']);
    act(() => canvas().getState().setTool('rect'));
    act(() => canvas().getState().setMode('comment'));
    expect(store().getState().selection).toEqual({ frameId: null, nodeIds: [] });
    expect(canvas().getState().tool).toBe('select');
    expect(canvas().getState().editSession).toBeNull();
  });

  it('Esc with nothing selected leaves edit mode, keeping changes', async () => {
    const { store, canvas, n } = await setup({ ids: ['n_herobody01'], tab: 'Pro' });
    setText(field('blur'), '2');
    act(() => store().getState().select({ frameId: null, nodeIds: [] }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(canvas().getState().mode).toBe('view');
    expect(n('n_herobody01').style.lg?.blur).toBe(2);
  });
});

describe('edit session', () => {
  const pre: DocOp = {
    op: 'setStyle',
    id: 'n_herobody01',
    breakpoint: 'lg',
    prop: 'blur',
    value: 1,
  };

  it('Discard reverts everything done in the session, and only that', async () => {
    const { store, canvas, n } = await setup({ mode: 'view' });
    act(() => {
      store().getState().apply([pre], { source: 'agent', label: 'Agent edit' });
    });
    act(() => canvas().getState().setMode('edit'));
    act(() =>
      store()
        .getState()
        .select({ frameId: FRAME, nodeIds: ['n_herotitle1'] }),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Pro' }));
    setText(field('blur'), '5');
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(n('n_herotitle1').hidden).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(canvas().getState().mode).toBe('view');
    expect(n('n_herotitle1').style.lg?.blur).toBeUndefined();
    expect(n('n_herotitle1').hidden).toBeUndefined();
    expect(n('n_herobody01').style.lg?.blur).toBe(1); // made before the session
    expect(
      store()
        .getState()
        .undoStack.map((s) => s.label),
    ).toEqual(['Agent edit']);
    expect(store().getState().redoStack).toHaveLength(2); // Redo brings it back
  });

  it('Save keeps the changes and returns to view mode', async () => {
    const { canvas, n, labels } = await setup({ ids: ['n_herotitle1'], tab: 'Pro' });
    setText(field('blur'), '5');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save' })));
    expect(canvas().getState().mode).toBe('view');
    expect(n('n_herotitle1').style.lg?.blur).toBe(5);
    expect(labels()).toEqual(['Set blur']);
  });

  it('viewers can’t enter edit mode', async () => {
    const r = renderEditor(<EditPanel />, { role: 'viewer', mode: 'edit' });
    expect(r.canvas().getState().mode).toBe('view');
    expect(screen.getByTestId('edit-panel').textContent).toMatch(/view access/);
  });
});

describe('insert tools', () => {
  it('a click inserts a flow rectangle into the container under the pointer', async () => {
    const { store, canvas, n, labels } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Rectangle (R)' }));
    expect(canvas().getState().tool).toBe('rect');
    press(node('n_hero000001'));
    const id = store().getState().selection.nodeIds[0]!;
    expect(n('n_hero000001').children).toContain(id);
    expect(n(id)).toMatchObject({
      type: 'box',
      tag: 'div',
      positioning: 'flow',
      name: 'Rectangle',
    });
    expect(n(id).style.base).toMatchObject({ width: 160, height: 100 });
    expect(canvas().getState().tool).toBe('select');
    expect(labels()).toEqual(['Insert rectangle']);
  });

  it('a drag sets the size; Alt places it absolutely; ellipse and line styles', async () => {
    const { store, n } = await setup();
    // zoom 0.5: 100×60 screen px is 200×120 CSS px
    fireEvent.keyDown(window, { key: 'o' });
    fireEvent.pointerDown(node('n_hero000001'), {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 110, clientY: 70 });
    expect(document.querySelector('[data-cd-insert-box]')).toBeTruthy();
    fireEvent.pointerUp(window, { pointerId: 1 });
    const ellipse = store().getState().selection.nodeIds[0]!;
    expect(n(ellipse).style.base).toMatchObject({ width: 200, height: 120, borderRadius: '50%' });

    fireEvent.keyDown(window, { key: 'l' });
    fireEvent.pointerDown(node('n_hero000001'), {
      button: 0,
      pointerId: 2,
      clientX: 10,
      clientY: 10,
      altKey: true,
    });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 60, clientY: 12 });
    fireEvent.pointerUp(window, { pointerId: 2 });
    const line = store().getState().selection.nodeIds[0]!;
    expect(n(line).positioning).toBe('absolute');
    expect(n(line).style.base).toMatchObject({ width: 100, height: 1 });
    expect(typeof n(line).style.base?.left).toBe('number');
  });

  it('text, arrow (vector) and component tools', async () => {
    const { store, n } = await setup();
    fireEvent.keyDown(window, { key: 't' });
    press(node('n_herotitle1')); // a leaf: inserts beside it, in its parent
    const text = store().getState().selection.nodeIds[0]!;
    expect(n(text)).toMatchObject({ type: 'text', tag: 'p', parentId: 'n_hero000001' });

    fireEvent.click(screen.getByRole('button', { name: 'Arrow (A)' }));
    fireEvent.pointerDown(node('n_hero000001'), {
      button: 0,
      pointerId: 3,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 50, clientY: 25 });
    fireEvent.pointerUp(window, { pointerId: 3 });
    const arrow = n(store().getState().selection.nodeIds[0]!);
    expect(arrow.type).toBe('svg');
    expect(arrow.positioning).toBe('absolute');

    fireEvent.click(screen.getByRole('button', { name: 'Insert component' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Button' }));
    press(node('n_hero000001'));
    const inst = n(store().getState().selection.nodeIds[0]!);
    expect(inst).toMatchObject({ type: 'instance', componentRef: { componentId: 'Button' } });
  });

  it('the image tool takes an https URL, then places it', async () => {
    const { store, n } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Image' }));
    const url = screen.getByRole('textbox', { name: 'Image URL' });
    fireEvent.change(url, { target: { value: 'javascript:alert(1)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place' }));
    expect(url.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(url, { target: { value: 'https://example.com/a.png' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place' }));
    press(node('n_hero000001'));
    const img = n(store().getState().selection.nodeIds[0]!);
    expect(img).toMatchObject({ type: 'image', props: { src: 'https://example.com/a.png' } });
  });

  it('viewers have no insert tools active', async () => {
    const r = renderEditor(<CanvasPane />, { role: 'viewer', mode: 'edit' });
    await act(async () => {});
    act(() => r.canvas().getState().setTool('rect'));
    press(node('n_hero000001'));
    expect(r.store().getState().undoStack).toHaveLength(0);
  });
});

describe('Pro tab (Story 3.3)', () => {
  it('every allowlisted StyleProp is editable for boxes and text', async () => {
    for (const id of ['n_hero000001', 'n_herotitle1']) {
      await setup({ ids: [id], tab: 'Pro' });
      for (const name of [/padding per side/, /Per-side widths/, /Per-corner radius/]) {
        const b = screen.queryByRole('button', { name });
        if (b && b.getAttribute('aria-pressed') !== 'true') fireEvent.click(b);
      }
      for (const name of ['min width', 'min height', 'max height'])
        fireEvent.click(screen.getByRole('button', { name }));
      fireEvent.click(screen.getByRole('button', { name: /All properties/ }));
      for (const p of STYLE_PROP_NAMES) expect(row(p), `${id} ${p}`).toBeTruthy();
      cleanup();
    }
  });

  it('edits a literal at the frame breakpoint as one undo step, marked as set here', async () => {
    const { n, labels } = await setup({ ids: ['n_herotitle1'], tab: 'Pro' });
    // the sample frame is 1280px wide: the lg breakpoint
    expect(screen.getByRole('tab', { name: 'lg •' }).getAttribute('aria-selected')).toBe('true');
    expect(row('blur').querySelector('[data-set-dot]')).toBeNull();
    setText(field('blur'), '2px');
    expect(n().style.lg?.blur).toBe(2);
    expect(row('blur').querySelector('[data-set-dot]')).toBeTruthy();
    expect(within(row('blur')).getByText('px')).toBeTruthy();
    expect(row('maxWidth').title).toMatch(/Inherited from base/);
    expect(labels()).toEqual(['Set blur']);
  });

  it('rejects invalid input without applying it', async () => {
    const { store } = await setup({ ids: ['n_herotitle1'], tab: 'Pro' });
    setText(field('blur'), 'banana');
    expect(store().getState().undoStack).toHaveLength(0);
    expect(field('blur').getAttribute('aria-invalid')).toBe('true');
  });

  it('edits at another breakpoint, resets a field and resets a section', async () => {
    const { n } = await setup({ ids: ['n_herotitle1'], tab: 'Pro' });
    fireEvent.click(screen.getByRole('tab', { name: 'base' }));
    setText(field('blur'), '1');
    expect(n().style.base?.blur).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reset Blur at base' }));
    expect(n().style.base?.blur).toBeUndefined();
    setText(field('boxShadow'), 'none');
    expect(n().style.base?.boxShadow).toBe('none');
    fireEvent.click(screen.getByRole('button', { name: 'Reset Effects' }));
    expect(n().style.base?.boxShadow).toBeUndefined();
  });

  it('coalesces arrow-key nudges into one undo step', async () => {
    const { store, n } = await setup({ ids: ['n_herotitle1'], tab: 'Pro' });
    fireEvent.click(screen.getByRole('tab', { name: 'base' }));
    const input = field('blur');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp', shiftKey: true });
    expect(n().style.base?.blur).toBe(12);
    expect(store().getState().undoStack).toHaveLength(1);
  });

  it('picks a token filtered to the prop kinds', async () => {
    const { n } = await setup({ ids: ['n_herotitle1'], tab: 'Pro' });
    fireEvent.click(within(row('color')).getByRole('button', { name: 'Text color token' }));
    const list = screen.getByRole('listbox', { name: 'Tokens' });
    const options = within(list).getAllByRole('option');
    expect(options.every((o) => o.textContent!.startsWith('color.'))).toBe(true);
    fireEvent.click(within(list).getByRole('button', { name: /^color\.accent/ }));
    expect(n().style.lg?.color).toEqual({ token: 'color.accent' });
    expect(within(row('color')).getByText(/color\.accent/)).toBeTruthy();
  });

  it('text controls: weight, italic, decoration, align, tracking in em, content', async () => {
    const { n } = await setup({ ids: ['n_herotitle1'], tab: 'Pro' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Weight' }), {
      target: { value: '900' },
    });
    expect(n().style.lg?.fontWeight).toBe(900);
    fireEvent.click(screen.getByRole('button', { name: 'Italic' }));
    expect(n().style.lg?.fontStyle).toBe('italic');
    fireEvent.click(screen.getByRole('button', { name: 'Strikethrough' }));
    expect(n().style.lg?.textDecoration).toBe('line-through');
    fireEvent.click(screen.getByRole('radio', { name: 'Align center' }));
    expect(n().style.lg?.textAlign).toBe('center');
    setText(field('letterSpacing'), '0.02');
    expect(n().style.lg?.letterSpacing).toBe('0.02em');
    setText(screen.getByRole('textbox', { name: 'Content' }), 'Hello');
    expect((n() as { props: { text: string } }).props.text).toBe('Hello');
  });

  it('Hug / Fixed / Fill write width and height for every selected node', async () => {
    const { n } = await setup({ ids: ['n_herotitle1', 'n_herobody01'], tab: 'Pro' });
    const height = screen.getByRole('radiogroup', { name: 'height sizing' });
    fireEvent.click(within(height).getByRole('radio', { name: 'Fill' }));
    expect([n('n_herotitle1').style.lg?.height, n('n_herobody01').style.lg?.height]).toEqual([
      'fill',
      'fill',
    ]);
    fireEvent.click(within(height).getByRole('radio', { name: 'Hug' }));
    expect(n('n_herobody01').style.lg?.height).toBe('hug');
    fireEvent.click(within(height).getByRole('radio', { name: 'Fixed' }));
    expect(typeof n('n_herobody01').style.lg?.height).toBe('number');
    const width = screen.getByRole('radiogroup', { name: 'width sizing' });
    fireEvent.click(within(width).getByRole('radio', { name: 'Fill' }));
    expect(n('n_herotitle1').style.lg?.width).toBe('fill');
  });

  it('layout: direction, the 3×3 alignment grid and linked padding', async () => {
    const { labels, store } = await setup();
    const n = () => store().getState().doc.nodes['n_hero000001']!;
    // start from no padding (the sample uses tokens) so the linked field takes a literal
    const sides = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];
    act(() => {
      store()
        .getState()
        .apply(
          (['base', 'lg'] as const).flatMap((breakpoint) =>
            sides.map((prop) => ({
              op: 'setStyle' as const,
              id: 'n_hero000001',
              breakpoint,
              prop,
              value: null,
            })),
          ),
          { source: 'system' },
        );
      store().getState().undoStack.length = 0;
      store()
        .getState()
        .select({ frameId: FRAME, nodeIds: ['n_hero000001'] });
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Pro' }));
    fireEvent.click(screen.getByRole('radio', { name: /Row/ }));
    expect(n().style.lg).toMatchObject({ display: 'flex', flexDirection: 'row' });
    fireEvent.click(screen.getByRole('gridcell', { name: 'Align bottom right' }));
    // a row: horizontal is justify-content, vertical is align-items
    expect(n().style.lg).toMatchObject({ justifyContent: 'flex-end', alignItems: 'flex-end' });
    setText(field('paddingTop'), '24');
    expect(n().style.lg).toMatchObject({
      paddingTop: 24,
      paddingRight: 24,
      paddingBottom: 24,
      paddingLeft: 24,
    });
    expect(labels()).toEqual(['Layout: row', 'Align children', 'Set padding']);
    expect(n().style.base?.paddingTop).toBeUndefined();
  });

  it('applies to every selected node and shows mixed values', async () => {
    const { n } = await setup({ ids: ['n_herotitle1', 'n_herobody01'], tab: 'Pro' });
    expect((field('fontSize') as HTMLInputElement).placeholder).toBe('Mixed');
    setText(field('blur'), '3');
    expect(n('n_herotitle1').style.lg?.blur).toBe(3);
    expect(n('n_herobody01').style.lg?.blur).toBe(3);
    expect(screen.getByText('2 layers')).toBeTruthy();
  });

  it('renames layers and toggles positioning and visibility', async () => {
    const { n } = await setup({ ids: ['n_herotitle1'], tab: 'Pro' });
    setText(screen.getByRole('textbox', { name: 'Layer name' }), 'Title');
    expect(n().name).toBe('Title');
    fireEvent.click(screen.getByRole('radio', { name: 'Absolute' }));
    expect(n().positioning).toBe('absolute');
    expect(row('left')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(n().hidden).toBe(true);
  });

  it('shows frame fields when a frame is selected', async () => {
    const { store, canvas } = await setup();
    act(() => store().getState().select({ frameId: FRAME, nodeIds: [] }));
    const width = screen.getByRole('spinbutton', { name: 'Frame width' });
    fireEvent.change(width, { target: { value: '768' } });
    fireEvent.blur(width);
    expect(store().getState().doc.frames[0]!.width).toBe(768);
    expect(screen.getByText(/md breakpoint/)).toBeTruthy();
    expect(canvas().getState().editBreakpoint).toBeNull();
  });
});

describe('Simple, Code and Tweaks tabs', () => {
  it('Simple shows the common properties', async () => {
    const { n } = await setup({ ids: ['n_herotitle1'] });
    expect(screen.getByTestId('simple-tab')).toBeTruthy();
    for (const p of ['color', 'fontSize', 'fontWeight', 'width', 'backgroundColor', 'borderRadius'])
      expect(row(p), p).toBeTruthy();
    setText(field('borderRadius'), '8');
    expect(n().style.lg?.borderRadius).toBe(8);
  });

  it('Code shows the selection’s generated HTML and CSS', async () => {
    await setup({ ids: ['n_herotitle1'], tab: 'Code' });
    const html = screen.getByTestId('code-html').textContent!;
    expect(html).toMatch(/^<h1 class="cd-n_herotitle1">Ship designs/);
    expect(html).not.toContain('data-cd-id');
    expect(screen.getByTestId('code-css').textContent).toContain('.cd-n_herotitle1 {');
    expect(screen.getByRole('button', { name: 'Copy HTML' })).toBeTruthy();
  });

  it('Tweaks overrides a design token for the project', async () => {
    const { store } = await setup({ tab: 'Tweaks' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Override a token' }), {
      target: { value: 'color.primary' },
    });
    expect(store().getState().doc.tokenOverrides['color.primary']).toBe('#4f46e5');
    fireEvent.click(screen.getByRole('button', { name: 'Remove override color.primary' }));
    expect(store().getState().doc.tokenOverrides['color.primary']).toBeUndefined();
  });
});
