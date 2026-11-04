// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react';
import { applyOps, sampleLandingDoc, starterDesignSystem, type DesignDoc } from '@crunch/doc-model';
import { afterEach, describe, expect, it } from 'vitest';
import { FrameView } from './FrameView';

const ds = starterDesignSystem();
afterEach(cleanup);

function mount(doc: DesignDoc, extra: Record<string, unknown> = {}) {
  const renders: string[] = [];
  const utils = render(
    <FrameView
      doc={doc}
      ds={ds}
      frameId="f_desktop001"
      shadow={false}
      onNodeRender={(id) => renders.push(id)}
      {...extra}
    />,
  );
  const rerender = (next: DesignDoc) =>
    act(() => {
      utils.rerender(
        <FrameView
          doc={next}
          ds={ds}
          frameId="f_desktop001"
          shadow={false}
          onNodeRender={(id) => renders.push(id)}
          {...extra}
        />,
      );
    });
  return { ...utils, renders, rerender };
}

describe('FrameView', () => {
  it('renders the frame tree with classes, annotations and instance parts', async () => {
    const { container } = mount(sampleLandingDoc());
    await act(async () => {});
    const h1 = container.querySelector('h1')!;
    expect(h1.textContent).toBe('Ship designs your engineers can build.');
    expect(h1.className).toBe('cd-n_herotitle1');
    expect(h1.getAttribute('data-cd-id')).toBe('n_herotitle1');
    const cta = container.querySelector('[data-cd-id="n_herocta001"][data-cd-part="n_btnroot01"]')!;
    expect(cta.tagName).toBe('BUTTON');
    expect(cta.textContent).toBe('Get started');
    const styles = [...container.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    expect(styles).toContain('.cd-n_herotitle1{');
    expect(styles).toContain(
      '@container cdframe (min-width:1024px){.cd-n_herotitle1{font-size:var(--text-6xl);}}',
    );
    expect(styles).toContain('--color-primary:#4f46e5;');
  });

  it('re-renders only the changed node (incremental updates)', async () => {
    const doc = sampleLandingDoc();
    const m = mount(doc);
    await act(async () => {});
    m.renders.length = 0;
    const next = applyOps(doc, [
      { op: 'setProps', id: 'n_feat2body00', patch: { text: 'Updated' } },
    ]).doc;
    m.rerender(next);
    expect(m.renders).toEqual(['n_feat2body00']);
    expect(m.container.querySelector('.cd-n_feat2body00')!.textContent).toBe('Updated');
  });

  it('re-renders children when the parent layout changes (fill depends on it)', async () => {
    const doc = sampleLandingDoc();
    const m = mount(doc);
    await act(async () => {});
    m.renders.length = 0;
    m.rerender(
      applyOps(doc, [
        {
          op: 'setStyle',
          id: 'n_hero000001',
          breakpoint: 'base',
          prop: 'flexDirection',
          value: 'row',
        },
      ]).doc,
    );
    expect(m.renders).toEqual(
      expect.arrayContaining(['n_hero000001', 'n_herotitle1', 'n_herobody01', 'n_herocta001']),
    );
    expect(m.renders).not.toContain('n_features01');
  });

  it('handles structural edits: insert, move, remove', async () => {
    const doc = sampleLandingDoc();
    const m = mount(doc);
    await act(async () => {});
    const a = applyOps(doc, [
      {
        op: 'insertSubtree',
        parentId: 'n_hero000001',
        index: 0,
        nodes: [
          {
            id: 'n_eyebrow001',
            type: 'text',
            tag: 'span',
            parentId: 'n_hero000001',
            children: [],
            positioning: 'flow',
            style: {},
            props: { text: 'New' },
          },
        ],
      },
      { op: 'moveNode', id: 'n_feat3card00', parentId: 'n_features01', index: 0 },
      { op: 'removeNode', id: 'n_nav0000001' },
    ]).doc;
    m.rerender(a);
    await act(async () => {});
    expect(m.container.querySelector('.cd-n_hero000001')!.firstElementChild!.textContent).toBe(
      'New',
    );
    expect(m.container.querySelector('.cd-n_features01')!.firstElementChild!.className).toBe(
      'cd-n_feat3card00',
    );
    expect(m.container.querySelector('nav')).toBeNull();
    const styles = [...m.container.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    expect(styles).not.toContain('.cd-n_nav0000001{');
  });

  it('applies token overrides and hides hidden nodes', async () => {
    const doc = sampleLandingDoc();
    const next = applyOps(doc, [
      { op: 'setTokenOverride', path: 'color.primary', value: '#ff0066' },
      { op: 'setNodeMeta', id: 'n_herobody01', patch: { hidden: true } },
    ]).doc;
    const m = mount(next);
    await act(async () => {});
    const styles = [...m.container.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    expect(styles).toContain('--color-primary:#ff0066;');
    expect(styles).toMatch(/\.cd-n_herobody01\{[^}]*display:none;/);
  });

  it('renders into a shadow root by default', async () => {
    const { container } = render(
      <FrameView doc={sampleLandingDoc()} ds={ds} frameId="f_desktop001" />,
    );
    await act(async () => {});
    const host = container.querySelector('[data-cd-frame-host]')!;
    expect(host.shadowRoot?.querySelector('h1')?.textContent).toContain('Ship designs');
    expect(container.querySelector('h1')).toBeNull();
  });
});
