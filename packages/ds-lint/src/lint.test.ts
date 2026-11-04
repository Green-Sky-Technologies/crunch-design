import { describe, expect, it } from 'vitest';
import {
  applyOps,
  parseDoc,
  sampleLandingDoc,
  starterDesignSystem,
  type DesignDoc,
  type Node,
  type StyleProps,
} from '@crunch/doc-model';
import { lintDoc } from './index';

type Kid = {
  id: string;
  type?: 'box' | 'text' | 'image' | 'svg' | 'instance';
  style?: StyleProps;
  text?: string;
  kids?: Kid[];
  extra?: Partial<Node>;
};

/** Build a one-frame doc from a compact tree. */
function docOf(rootStyle: StyleProps, kids: Kid[]): DesignDoc {
  const nodes: Record<string, Node> = {};
  const add = (k: Kid, parentId: string | null): string => {
    const base = {
      id: k.id,
      parentId,
      children: [] as string[],
      positioning: 'flow' as const,
      style: { base: k.style ?? {} },
    };
    let n: Node;
    switch (k.type ?? 'box') {
      case 'text':
        n = { ...base, type: 'text', tag: 'p', props: { text: k.text ?? 'Hello world' } };
        break;
      case 'image':
        n = { ...base, type: 'image', props: { src: 'https://example.com/a.png', alt: '' } };
        break;
      case 'svg':
        n = { ...base, type: 'svg', props: { svg: '<svg viewBox="0 0 1 1"></svg>' } };
        break;
      case 'instance':
        n = {
          ...base,
          type: 'instance',
          componentRef: { componentId: 'Button', variant: {} },
          props: { values: {} },
        };
        break;
      default:
        n = { ...base, type: 'box', tag: 'div', props: {} };
    }
    n = { ...n, ...k.extra } as Node;
    nodes[n.id] = n;
    n.children = (k.kids ?? []).map((c) => add(c, n.id));
    return n.id;
  };
  const root = add({ id: 'n_root00001', style: rootStyle, kids }, null);
  return parseDoc({
    schemaVersion: 1,
    frames: [
      {
        id: 'f_frame0001',
        name: 'F',
        rootNodeId: root,
        canvas: { x: 0, y: 0 },
        width: 1280,
        height: 'auto',
        previewBreakpoints: [],
      },
    ],
    nodes,
    sliders: [],
    tokenOverrides: {},
  });
}

const ds = starterDesignSystem();
const codes = (doc: DesignDoc, opts = {}) =>
  lintDoc(doc, ds, opts).map((i) => `${i.code}:${i.nodeId ?? ''}:${i.prop ?? ''}`);

describe('lintDoc', () => {
  it('a token-only doc built from the starter system is clean', () => {
    expect(lintDoc(sampleLandingDoc(), ds)).toEqual([]);
  });

  it('flags literals that equal tokens and fixes them', () => {
    const doc = docOf({}, [
      {
        id: 'n_a00000001',
        style: { backgroundColor: '#4F46E5', borderRadius: '0.5rem', width: '1rem' },
      },
      { id: 'n_t00000001', type: 'text', style: { fontWeight: 'bold', color: 'rgb(24, 24, 27)' } },
    ]);
    const issues = lintDoc(doc, ds);
    // Issues per node follow the STYLE_PROPS registry order.
    expect(issues.map((i) => [i.code, i.prop, i.severity, i.fix?.[0]])).toEqual([
      [
        'literal-should-be-token',
        'width',
        'info',
        expect.objectContaining({ value: { token: 'space.4' } }),
      ],
      [
        'literal-should-be-token',
        'backgroundColor',
        'warning',
        {
          op: 'setStyle',
          id: 'n_a00000001',
          breakpoint: 'base',
          prop: 'backgroundColor',
          value: { token: 'color.primary' },
        },
      ],
      [
        'literal-should-be-token',
        'borderRadius',
        'warning',
        expect.objectContaining({ value: { token: 'radius.md' } }),
      ],
      [
        'literal-should-be-token',
        'fontWeight',
        'warning',
        expect.objectContaining({ value: { token: 'weight.bold' } }),
      ],
      [
        'literal-should-be-token',
        'color',
        'warning',
        expect.objectContaining({ value: { token: 'color.text' } }),
      ],
    ]);
    // Applying every fix yields a clean doc.
    const fixed = applyOps(
      doc,
      issues.flatMap((i) => i.fix ?? []),
    ).doc;
    expect(lintDoc(fixed, ds)).toEqual([]);
  });

  it('off-system key values: nearest fix only when close', () => {
    const doc = docOf({}, [
      {
        id: 'n_a00000001',
        style: { backgroundColor: '#4f47e6', borderColor: '#00ff88', fontSize: 15 },
      },
    ]);
    const [size, bg, border] = lintDoc(doc, ds);
    expect(bg).toMatchObject({
      code: 'literal-should-be-token',
      fix: [{ value: { token: 'color.primary' } }],
    });
    expect(border).toMatchObject({ code: 'literal-should-be-token', prop: 'borderColor' });
    expect(border!.fix).toBeUndefined();
    // 15px sits between text.sm (14) and text.base (16); ties go to the smaller step.
    expect(size).toMatchObject({ prop: 'fontSize', fix: [{ value: { token: 'text.sm' } }] });
  });

  it('off-scale spacing snaps to the nearest step', () => {
    const doc = docOf({}, [
      {
        id: 'n_a00000001',
        style: { paddingTop: 13, gap: '8px', marginLeft: -16, marginTop: 0, paddingLeft: '5%' },
      },
    ]);
    const issues = lintDoc(doc, ds);
    expect(
      issues.map((i) => [i.code, i.prop, i.fix?.[0] && (i.fix[0] as { value: unknown }).value]),
    ).toEqual([
      ['literal-should-be-token', 'gap', { token: 'space.2' }],
      ['off-scale-spacing', 'paddingTop', { token: 'space.3' }],
    ]);
  });

  it('checks WCAG AA contrast, including inherited backgrounds and large text', () => {
    const doc = docOf({ backgroundColor: { token: 'color.background' } }, [
      { id: 'n_t00000001', type: 'text', style: { color: '#999999' } }, // 2.85:1 on white
      { id: 'n_t00000002', type: 'text', style: { color: '#8a8a8a', fontSize: 32 } }, // 3.45:1, large: passes 3:1
      {
        id: 'n_b00000001',
        style: { backgroundColor: { token: 'color.primary' } },
        kids: [
          { id: 'n_t00000003', type: 'text', style: { color: { token: 'color.primaryText' } } }, // ok
          { id: 'n_t00000004', type: 'text', style: { color: { token: 'color.text' } } }, // dark on indigo
        ],
      },
      {
        id: 'n_b00000002',
        style: { backgroundImage: 'linear-gradient(#000000, #ffffff)' },
        kids: [{ id: 'n_t00000005', type: 'text', style: { color: '#777777' } }],
      },
    ]);
    const contrast = lintDoc(doc, ds).filter((i) => i.code === 'contrast');
    expect(contrast.map((i) => i.nodeId)).toEqual(['n_t00000001', 'n_t00000004']);
    expect(contrast[0]!.message).toMatch(/2\.85:1 is below WCAG AA 4\.5:1/);
    // The fix picks a passing color token closest to the current color.
    const fixed = applyOps(
      doc,
      contrast.flatMap((i) => i.fix ?? []),
    ).doc;
    expect(lintDoc(fixed, ds).filter((i) => i.code === 'contrast')).toEqual([]);
  });

  it('reports contrast per breakpoint and per theme', () => {
    const doc = docOf({}, [
      {
        id: 'n_t00000001',
        type: 'text',
        extra: { style: { base: { color: { token: 'color.text' } }, md: { color: '#cccccc' } } },
      },
    ]);
    const c = lintDoc(doc, ds).filter((i) => i.code === 'contrast');
    expect(c.map((i) => i.breakpoint)).toEqual(['md']);
    // In dark theme the text token is light, the default background is dark: fine.
    const ok = docOf({ backgroundColor: { token: 'color.background' } }, [
      { id: 'n_t00000001', type: 'text', style: { color: { token: 'color.text' } } },
    ]);
    expect(lintDoc(ok, ds, { theme: 'dark' })).toEqual([]);
    const bad = docOf({ backgroundColor: '#ffffff' }, [
      { id: 'n_t00000001', type: 'text', style: { color: { token: 'color.text' } } },
    ]);
    expect(lintDoc(bad, ds, { theme: 'dark' }).map((i) => i.code)).toContain('contrast');
  });

  it('unknown tokens, missing alt, missing components and fonts', () => {
    const doc = docOf({}, [
      { id: 'n_a00000001', style: { color: { token: 'color.nope' }, fontFamily: 'Comic Sans MS' } },
      { id: 'n_t00000001', type: 'text', style: { fontFamily: 'inter, sans-serif' } },
      { id: 'n_i00000001', type: 'image' },
      {
        id: 'n_i00000002',
        type: 'image',
        extra: {
          props: { src: 'https://example.com/a.png', alt: '', role: 'presentation' },
        } as Partial<Node>,
      },
      { id: 'n_s00000001', type: 'svg' },
      {
        id: 'n_c00000001',
        type: 'instance',
        extra: { componentRef: { componentId: 'Card', variant: {} } } as Partial<Node>,
      },
      {
        id: 'n_c00000002',
        type: 'instance',
        extra: {
          componentRef: { componentId: 'Button', variant: { variant: 'ghost' } },
          props: { values: { icon: 'x' } },
        } as Partial<Node>,
      },
    ]);
    expect(codes(doc)).toEqual([
      'font-not-in-system:n_a00000001:fontFamily',
      'unknown-token:n_a00000001:color',
      'font-not-in-system:n_t00000001:fontFamily',
      'missing-alt:n_i00000001:alt',
      'missing-alt:n_s00000001:ariaLabel',
      'missing-component:n_c00000001:',
      'missing-component:n_c00000002:',
      'missing-component:n_c00000002:',
    ]);
    const font = lintDoc(doc, ds).find((i) => i.nodeId === 'n_t00000001')!;
    expect(font.fix).toEqual([
      {
        op: 'setStyle',
        id: 'n_t00000001',
        breakpoint: 'base',
        prop: 'fontFamily',
        value: { token: 'font.sans' },
      },
    ]);

    const withRefs = { ...doc, tokenOverrides: { 'color.gone': '#fff' } };
    expect(lintDoc(withRefs, ds).at(-1)).toMatchObject({
      code: 'unknown-token',
      severity: 'warning',
    });
  });

  it('honours nodeIds and is deterministic', () => {
    const doc = docOf({}, [
      { id: 'n_a00000001', style: { paddingTop: 13 } },
      { id: 'n_a00000002', style: { paddingTop: 13 } },
    ]);
    expect(codes(doc, { nodeIds: ['n_a00000002'] })).toEqual([
      'off-scale-spacing:n_a00000002:paddingTop',
    ]);
    expect(lintDoc(doc, ds)).toEqual(lintDoc(structuredClone(doc), structuredClone(ds)));
  });

  it('lints a 5,000-node doc quickly', () => {
    const kids: Kid[] = [];
    const colors = ['#999999', '#4f46e5', '#123456', { token: 'color.text' } as const];
    for (let i = 0; i < 1250; i++) {
      const id = String(i).padStart(7, '0');
      kids.push({
        id: `n_c${id}`,
        style: {
          paddingTop: i % 7 === 0 ? 13 : { token: 'space.4' },
          backgroundColor: i % 5 === 0 ? '#f6f6f4' : { token: 'color.surface' },
        },
        kids: [
          {
            id: `n_h${id}`,
            type: 'text',
            style: { color: colors[i % 4]!, fontSize: i % 3 ? { token: 'text.lg' } : 18 },
          },
          { id: `n_p${id}`, type: 'text', style: { color: { token: 'color.muted' } } },
          { id: `n_i${id}`, type: i % 2 ? 'image' : 'box' },
        ],
      });
    }
    const big = docOf({ backgroundColor: { token: 'color.background' }, display: 'flex' }, kids);
    expect(Object.keys(big.nodes).length).toBe(5001);
    lintDoc(big, ds); // warm up
    const runs: number[] = [];
    let issues = 0;
    for (let r = 0; r < 5; r++) {
      const t = performance.now();
      issues = lintDoc(big, ds).length;
      runs.push(performance.now() - t);
    }
    const median = runs.sort((a, b) => a - b)[2]!;
    console.log(`[ds-lint] 5,001 nodes: median ${median.toFixed(1)}ms, ${issues} issues`);
    expect(issues).toBeGreaterThan(1000);
    expect(median).toBeLessThan(250);
  });
});
