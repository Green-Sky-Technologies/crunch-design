import {
  applyOps,
  sampleLandingDoc,
  starterDesignSystem,
  type InstanceNode,
} from '@crunch/doc-model';
import { describe as suite, expect, it } from 'vitest';
import { layoutOf, nodeRules, ROOT_LAYOUT } from './css';
import { describe, expandInstance, rnodeFor, DEFAULT_OPTIONS } from './describe';
import { renderSubtreeStatic } from './static';
import { sanitizeSvg } from './svg';

const ds = starterDesignSystem();
const bps = { md: 768, lg: 1024 };

suite('css', () => {
  it('emits base rules plus container-query diffs per breakpoint', () => {
    const css = nodeRules(
      '.x',
      {
        base: { fontSize: { token: 'text.4xl' }, paddingTop: 16 },
        lg: { fontSize: { token: 'text.6xl' } },
      },
      ROOT_LAYOUT,
      { absolute: false, isBox: false, hidden: false },
      bps,
    );
    expect(css).toBe(
      '.x{font-size:var(--text-4xl);padding-top:16px;}@container cdframe (min-width:1024px){.x{font-size:var(--text-6xl);}}',
    );
  });

  it('resolves fill/hug against the parent layout at each breakpoint', () => {
    const parents = layoutOf({
      base: { display: 'flex', flexDirection: 'column' },
      md: { flexDirection: 'row' },
    });
    const css = nodeRules(
      '.c',
      { base: { width: 'fill' } },
      parents,
      { absolute: false, isBox: true, hidden: false },
      bps,
    );
    // column parent: width fill = stretch on cross axis; row parent at md: grow on main axis
    expect(css).toContain('.c{position:relative;align-self:stretch;}');
    expect(css).toContain(
      '@container cdframe (min-width:768px){.c{flex-grow:1;flex-basis:0%;min-width:0;align-self:auto;}}',
    );
    expect(
      nodeRules(
        '.h',
        { base: { width: 'hug' } },
        ROOT_LAYOUT,
        { absolute: false, isBox: false, hidden: false },
        bps,
      ),
    ).toBe('.h{width:fit-content;}');
  });

  it('only emits insets for absolute nodes and combines translate', () => {
    const style = { base: { top: 10, left: 4, translateX: 2 } };
    expect(
      nodeRules('.a', style, ROOT_LAYOUT, { absolute: true, isBox: true, hidden: false }, bps),
    ).toBe('.a{position:absolute;top:10px;left:4px;translate:2px 0px;}');
    expect(
      nodeRules('.f', style, ROOT_LAYOUT, { absolute: false, isBox: true, hidden: false }, bps),
    ).toBe('.f{position:relative;translate:2px 0px;}');
  });
});

suite('describe', () => {
  const doc = sampleLandingDoc();

  it('describes text with escaping left to the renderer and annotations optional', () => {
    const d = describe(rnodeFor(doc.nodes['n_herotitle1']!, ds), DEFAULT_OPTIONS);
    expect(d).toMatchObject({ tag: 'h1', text: 'Ship designs your engineers can build.' });
    expect(d.attrs['data-cd-id']).toBe('n_herotitle1');
    expect(
      describe(rnodeFor(doc.nodes['n_herotitle1']!, ds), { annotate: false, showHidden: false })
        .attrs['data-cd-id'],
    ).toBeUndefined();
  });

  it('expands instances with variants, prop bindings and instance style overrides', () => {
    const { doc: d2 } = applyOps(doc, [
      { op: 'setStyle', id: 'n_herocta001', breakpoint: 'base', prop: 'marginTop', value: 8 },
    ]);
    const r = expandInstance(d2.nodes['n_herocta001'] as InstanceNode, ds);
    expect(r.node.type).toBe('box');
    expect(r.key).toBe('n_herocta001-n_btnroot01');
    expect(r.style.base?.marginTop).toBe(8);
    expect(r.children?.[0]?.node).toMatchObject({ type: 'text', props: { text: 'Get started' } });

    const nav = expandInstance(doc.nodes['n_navcta0001'] as InstanceNode, ds);
    expect(nav.style.base?.backgroundColor).toBe('transparent'); // secondary variant
  });

  it('renders a placeholder for missing components', () => {
    const r = expandInstance(
      {
        ...(doc.nodes['n_herocta001'] as InstanceNode),
        componentRef: { componentId: 'Nope', variant: {} },
      },
      ds,
    );
    expect(r.node).toMatchObject({ type: 'text', props: { text: 'Missing component: Nope' } });
  });
});

suite('sanitizeSvg', () => {
  it('keeps allowlisted markup and canonical attribute casing', () => {
    const out = sanitizeSvg(
      '<svg viewBox="0 0 24 24" fill="none"><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><path d="M0 0h24" stroke="url(#g)"/></svg>',
    );
    expect(out).toBe(
      '<svg viewBox="0 0 24 24" fill="none"><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient><path d="M0 0h24" stroke="url(#g)"/></svg>',
    );
  });

  it('strips scripts, handlers, external refs and unknown elements', () => {
    const out = sanitizeSvg(
      '<svg onload="x()"><script>alert(1)</script><a href="javascript:x"><path d="M0" onclick="y" fill="url(https://e.vil/x)"/></a><use href="https://e.vil#x"/><style>*{}</style><!-- c --></svg>',
    );
    expect(out).toBe('<svg><path d="M0"/><use/></svg>');
  });

  it('escapes text and attribute values', () => {
    expect(sanitizeSvg('<svg><text x="1&quot; onload=&quot;x">a<b</text></svg>')).not.toMatch(
      /onload="x"/,
    );
  });
});

suite('renderSubtreeStatic (edit panel Code tab)', () => {
  it('renders one node’s subtree without annotations, against its real parent layout', () => {
    const doc = sampleLandingDoc();
    const r = renderSubtreeStatic(doc, ds, 'n_hero000001');
    expect(r.html.startsWith('<section class="cd-n_hero000001">')).toBe(true);
    expect(r.html).toContain('Ship designs your engineers can build.');
    expect(r.html).not.toContain('data-cd-id');
    expect(r.css).toContain('.cd-n_hero000001');
    expect(r.css).toContain('.cd-n_herotitle1');
    expect(r.css).not.toContain('.cd-n_root000001');
    expect(() => renderSubtreeStatic(doc, ds, 'n_missing001')).toThrow();
  });
});
