import { describe, expect, it } from 'vitest';
import {
  emptyDoc,
  sampleLandingDoc,
  starterDesignSystem,
  type DesignDoc,
  type Node,
} from '@crunch/doc-model';
import { parseCssColor, rgbaToCss } from './color';
import { parseBoxShadow, parseGradient } from './css-values';
import type { FrameSpec, NodeSpec, TextSpec } from './plan';
import { flattenSpecs, hashValue, reconcile } from './reconcile';
import { breakpointForWidth, docToFigmaPlan, fontStyleName } from './to-figma';
import { tokensToVariables, variableNameToTokenPath } from './variables';

const ds = starterDesignSystem();
const opts = { projectId: 'p1', docVersion: 3 };

function find(root: NodeSpec, cdId: string): NodeSpec {
  const n = flattenSpecs(root).find((s) => s.cdId === cdId);
  if (!n) throw new Error(`no spec ${cdId}`);
  return n;
}

/** A one-frame doc from a node list (first node is the root). */
function docOf(nodes: Node[], frame: Partial<DesignDoc['frames'][number]> = {}): DesignDoc {
  const d = emptyDoc();
  for (const n of nodes) d.nodes[n.id] = n;
  d.frames.push({
    id: 'f_frame00001',
    name: 'Test',
    rootNodeId: nodes[0]!.id,
    canvas: { x: 0, y: 0 },
    width: 800,
    height: 'auto',
    previewBreakpoints: [],
    ...frame,
  });
  return d;
}

const box = (
  id: string,
  parentId: string | null,
  children: string[],
  base: object,
  extra: Partial<Node> = {},
): Node =>
  ({
    id,
    type: 'box',
    tag: 'div',
    parentId,
    children,
    positioning: 'flow',
    props: {},
    style: { base },
    ...extra,
  }) as Node;
const text = (id: string, parentId: string, t: string, base: object = {}): Node =>
  ({
    id,
    type: 'text',
    tag: 'p',
    parentId,
    children: [],
    positioning: 'flow',
    props: { text: t },
    style: { base },
  }) as Node;

describe('values', () => {
  it('parses CSS colors to Figma RGBA and back', () => {
    expect(parseCssColor('#4f46e5')).toEqual({ r: 0.3098, g: 0.2745, b: 0.898, a: 1 });
    expect(parseCssColor('#fff8')).toMatchObject({ r: 1, a: 0.5333 });
    expect(parseCssColor('rgba(0,0,0,0.06)')).toEqual({ r: 0, g: 0, b: 0, a: 0.06 });
    expect(parseCssColor('rgb(255 0 0 / 50%)')).toEqual({ r: 1, g: 0, b: 0, a: 0.5 });
    expect(parseCssColor('hsl(120, 100%, 50%)')).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    expect(parseCssColor('oklch(0.6 0.1 200)')).toBeNull();
    expect(rgbaToCss({ r: 0.3098, g: 0.2745, b: 0.898, a: 1 })).toBe('#4f46e5');
    expect(rgbaToCss({ r: 0, g: 0, b: 0, a: 0.5 })).toBe('#00000080');
  });

  it('parses shadows and gradients', () => {
    expect(parseBoxShadow('0 4px 12px rgba(0,0,0,0.08), inset 0 1px 0 #fff')).toEqual([
      {
        type: 'DROP_SHADOW',
        color: { r: 0, g: 0, b: 0, a: 0.08 },
        offset: { x: 0, y: 4 },
        radius: 12,
        spread: 0,
      },
      {
        type: 'INNER_SHADOW',
        color: { r: 1, g: 1, b: 1, a: 1 },
        offset: { x: 0, y: 1 },
        radius: 0,
        spread: 0,
      },
    ]);
    const g = parseGradient('linear-gradient(90deg, #000 0%, #fff 100%)');
    expect(g).toMatchObject({ type: 'GRADIENT_LINEAR', stops: [{ position: 0 }, { position: 1 }] });
    // 90deg is Figma's default left-to-right gradient: identity transform
    expect(g && 'transform' in g ? g.transform : null).toEqual([
      [1, 0, 0],
      [-0, 1, 0],
    ]);
    expect(parseGradient('conic-gradient(red, blue)')).toBeNull();
  });

  it('maps weights to Figma style names and widths to breakpoints', () => {
    expect(fontStyleName(400, false)).toBe('Regular');
    expect(fontStyleName(600, false)).toBe('Semi Bold');
    expect(fontStyleName(400, true)).toBe('Italic');
    expect(fontStyleName(700, true)).toBe('Bold Italic');
    expect(breakpointForWidth(375, ds.breakpoints)).toBe('base');
    expect(breakpointForWidth(800, ds.breakpoints)).toBe('md');
    expect(breakpointForWidth(1280, ds.breakpoints)).toBe('lg');
  });
});

describe('docToFigmaPlan: sample landing page', () => {
  const plan = docToFigmaPlan(sampleLandingDoc(), ds, opts);
  const root = plan.frames[0]!.root;

  it('builds one top-level frame per doc frame at the push width', () => {
    expect(plan.frames).toHaveLength(1);
    expect(plan.frames[0]).toMatchObject({ breakpoint: 'lg', width: 1280 });
    expect(root).toMatchObject({
      kind: 'FRAME',
      cdId: 'n_root000001',
      sizing: { horizontal: 'FIXED' },
    });
    expect(root.width).toBe(1280);
  });

  it('maps flex to auto-layout with token-bound spacing and padding', () => {
    const nav = find(root, 'n_nav0000001') as FrameSpec;
    expect(nav.layout).toMatchObject({
      mode: 'HORIZONTAL',
      primaryAlign: 'SPACE_BETWEEN',
      counterAlign: 'CENTER',
      padding: { top: 16, bottom: 16, left: 24, right: 24 },
    });
    expect(nav.binds).toMatchObject({ paddingTop: 'space.4', paddingLeft: 'space.6' });
    expect(nav.sizing.horizontal).toBe('FILL'); // block-level stretch in a column parent
    expect(nav.strokeWeights).toEqual({ top: 0, right: 0, bottom: 1, left: 0 });
    expect(nav.strokes[0]).toMatchObject({ type: 'SOLID', bind: 'color.border' });

    const hero = find(root, 'n_hero000001') as FrameSpec;
    expect(hero.layout).toMatchObject({ mode: 'VERTICAL', itemSpacing: 24, counterAlign: 'MIN' });
    expect(hero.binds.itemSpacing).toBe('space.6');
    // lg breakpoint override applied
    expect(hero.layout.padding.top).toBe(96);
  });

  it('maps text styles with inherited font family and bound color', () => {
    const h1 = find(root, 'n_herotitle1') as TextSpec;
    expect(h1).toMatchObject({
      kind: 'TEXT',
      characters: 'Ship designs your engineers can build.',
      font: { family: 'Inter', style: 'Bold' },
      fontSize: 60,
      lineHeight: { unit: 'PERCENT', value: 115 },
    });
    expect(h1.fills[0]).toMatchObject({ type: 'SOLID', bind: 'color.text' });
    expect(h1.binds).toMatchObject({
      fontSize: 'text.6xl',
      fontWeight: 'weight.bold',
      fontFamily: 'font.sans',
    });
    expect(h1.maxWidth).toBe(600); // 20ch at 60px
  });

  it('turns DS components into Figma components, one per variant used', () => {
    expect(plan.components.map((c) => c.key).sort()).toEqual([
      'Button?variant=primary',
      'Button?variant=secondary',
    ]);
    const secondary = plan.components.find((c) => c.key === 'Button?variant=secondary')!;
    expect(secondary.name).toBe('Button / variant=secondary');
    const r = secondary.root as FrameSpec;
    expect(r.strokes).toHaveLength(1); // variant style: 1px solid border
    const cta = find(root, 'n_herocta001');
    expect(cta).toMatchObject({
      kind: 'INSTANCE',
      componentKey: 'Button?variant=primary',
      textOverrides: { n_btnlabel1: 'Get started' },
    });
  });

  it('pushes tokens as variables with a mode per theme', () => {
    expect(plan.variables?.modes).toEqual(['light', 'dark']);
    const bg = plan.variables!.variables.find((v) => v.path === 'color.background')!;
    expect(bg).toMatchObject({ name: 'color/background', type: 'COLOR' });
    expect(bg.valuesByMode.light).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(rgbaToCss(bg.valuesByMode.dark as never)).toBe('#0b0b0f');
    const sp = plan.variables!.variables.find((v) => v.path === 'space.4')!;
    expect(sp).toMatchObject({ type: 'FLOAT', valuesByMode: { light: 16, dark: 16 } });
    expect(plan.variables!.variables.some((v) => v.path === 'shadow.sm')).toBe(false);
    expect(plan.report.some((r) => r.subject === 'shadow.sm')).toBe(true);
  });

  it('is deterministic (stable hashes enable skip-unchanged on re-push)', () => {
    const again = docToFigmaPlan(sampleLandingDoc(), ds, opts);
    expect(again).toEqual(plan);
    expect(again.frames[0]!.root.hash).toBe(root.hash);
  });

  it('picks the breakpoint from the push width', () => {
    const mobile = docToFigmaPlan(sampleLandingDoc(), ds, { ...opts, width: 375 });
    expect(mobile.frames[0]).toMatchObject({ width: 375, breakpoint: 'base' });
    const hero = find(mobile.frames[0]!.root, 'n_hero000001') as FrameSpec;
    expect(hero.layout.padding.top).toBe(64);
    const h1 = find(mobile.frames[0]!.root, 'n_herotitle1') as TextSpec;
    expect(h1.fontSize).toBe(36);
  });

  it('can push without variables (literal values, no bindings)', () => {
    const p = docToFigmaPlan(sampleLandingDoc(), ds, { ...opts, variables: false });
    expect(p.variables).toBeNull();
    expect(flattenSpecs(p.frames[0]!.root).every((s) => Object.keys(s.binds).length === 0)).toBe(
      true,
    );
  });
});

describe('docToFigmaPlan: layout and report', () => {
  it('maps hug/fill/fixed, wrap, absolute children and effects', () => {
    const d = docOf(
      [
        box('n_root00', null, ['n_row000', 'n_abs000'], {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          width: 800,
          height: 600,
        }),
        box('n_row000', 'n_root00', ['n_a00000', 'n_b00000'], {
          display: 'flex',
          flexWrap: 'wrap',
          columnGap: 8,
          rowGap: 12,
          width: 'fill',
          boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
          opacity: 0.5,
          rotate: 15,
          overflow: 'hidden',
        }),
        box('n_a00000', 'n_row000', [], { width: 120, height: 40 }),
        box('n_b00000', 'n_row000', [], { flexGrow: 1, height: 'hug' }),
        box(
          'n_abs000',
          'n_root00',
          [],
          { top: 10, right: 20, width: 100, height: 50 },
          { positioning: 'absolute' },
        ),
      ],
      { height: 600 },
    );
    const plan = docToFigmaPlan(d, ds, opts);
    const root = plan.frames[0]!.root;
    expect(root.sizing).toEqual({ horizontal: 'FIXED', vertical: 'FIXED' });
    const row = find(root, 'n_row000') as FrameSpec;
    expect(row.layout).toMatchObject({
      mode: 'HORIZONTAL',
      wrap: true,
      itemSpacing: 8,
      counterAxisSpacing: 12,
    });
    expect(row.sizing.horizontal).toBe('FILL');
    expect(row.effects).toEqual([
      {
        type: 'DROP_SHADOW',
        color: { r: 0, g: 0, b: 0, a: 0.2 },
        offset: { x: 0, y: 2 },
        radius: 4,
        spread: 0,
      },
    ]);
    expect(row).toMatchObject({ opacity: 0.5, rotation: -15, clipsContent: true });
    expect(find(root, 'n_a00000').sizing).toEqual({ horizontal: 'FIXED', vertical: 'FIXED' });
    expect(find(root, 'n_b00000').sizing).toEqual({ horizontal: 'FILL', vertical: 'HUG' });
    const abs = find(root, 'n_abs000');
    expect(abs.absolute).toEqual({ x: 680, y: 10 }); // 800 - 20 - 100
  });

  it('reports what it cannot represent', () => {
    const d = docOf([
      box('n_root00', null, ['n_t00000', 'n_g00000'], {
        marginTop: 8,
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
      }),
      text('n_t00000', 'n_root00', 'Hi', {
        backgroundColor: '#fff',
        paddingTop: 4,
        color: 'oklch(0.5 0.1 100)',
      }),
      box('n_g00000', 'n_root00', [], { backgroundColor: { token: 'color.nope' } }),
    ]);
    const { report } = docToFigmaPlan(d, ds, opts);
    const messages = report.map((r) => r.message).join('\n');
    expect(messages).toMatch(/Margins/);
    expect(messages).toMatch(/grid/i);
    expect(messages).toMatch(/no background/);
    expect(messages).toMatch(/no padding/);
    expect(messages).toMatch(/sRGB/);
    expect(messages).toMatch(/Unknown token "color.nope"/);
    expect(report.every((r) => ['info', 'warning', 'error'].includes(r.severity))).toBe(true);
  });

  it('reports missing components and frames', () => {
    const d = docOf([
      box('n_root00', null, ['n_i00000'], { display: 'flex' }),
      {
        id: 'n_i00000',
        type: 'instance',
        parentId: 'n_root00',
        children: [],
        positioning: 'flow',
        style: {},
        componentRef: { componentId: 'Card', variant: {} },
        props: { values: {} },
      } as Node,
    ]);
    const plan = docToFigmaPlan(d, ds, { ...opts, frameIds: ['f_frame00001', 'f_missing01'] });
    expect(plan.report.filter((r) => r.severity === 'error').map((r) => r.message)).toEqual(
      expect.arrayContaining([expect.stringMatching(/Card/), 'Frame not found']),
    );
    expect((plan.frames[0]!.root as FrameSpec).children).toHaveLength(0);
  });
});

describe('reconcile (update in place)', () => {
  const plan = docToFigmaPlan(sampleLandingDoc(), ds, opts);
  const planned = flattenSpecs(plan.frames[0]!.root).map((s) => ({
    cdId: s.cdId,
    kind: s.kind,
    hash: s.hash,
  }));

  it('first push creates everything', () => {
    const r = reconcile(planned, []);
    expect(r.create.size).toBe(planned.length);
    expect(r.update.size + r.remove.length).toBe(0);
  });

  it('second push updates matched nodes and only creates/removes the difference', () => {
    const existing = planned.map((p, i) => ({
      cdId: p.cdId,
      figmaId: `1:${i}`,
      kind: p.kind,
      hash: p.hash,
    }));
    existing.push({ cdId: 'n_deleted001', figmaId: '1:999', kind: 'FRAME', hash: 'x' });
    existing.push({ cdId: planned[1]!.cdId, figmaId: '1:1000', kind: planned[1]!.kind, hash: '' }); // user duplicate
    const next = planned.filter((p) => p.cdId !== 'n_logo000001');
    next.push({ cdId: 'n_new0000001', kind: 'TEXT', hash: 'h' });
    const r = reconcile(next, existing);
    expect(r.create).toEqual(new Set(['n_new0000001']));
    expect(r.remove.sort()).toEqual(
      ['1:999', `1:${planned.findIndex((p) => p.cdId === 'n_logo000001')}`].sort(),
    );
    expect(r.detach).toEqual(['1:1000']);
    expect(r.update.size).toBe(next.length - 1);
    expect(r.unchanged.size).toBe(next.length - 1);
  });

  it('recreates nodes whose kind changed', () => {
    const r = reconcile(
      [{ cdId: 'n_a', kind: 'TEXT', hash: 'h' }],
      [{ cdId: 'n_a', figmaId: '1:1', kind: 'FRAME' }],
    );
    expect(r.remove).toEqual(['1:1']);
    expect(r.create).toEqual(new Set(['n_a']));
  });

  it('hashes are order-independent for object keys', () => {
    expect(hashValue({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      hashValue({ b: [1, { d: 3, c: 2 }], a: 1 }),
    );
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
  });
});

describe('variables', () => {
  it('maps names both ways', () => {
    expect(variableNameToTokenPath('color/primary')).toBe('color.primary');
    expect(variableNameToTokenPath('Color/Primary 500')).toBe('color.Primary-500');
    expect(variableNameToTokenPath('spacing')).toBeNull();
    expect(variableNameToTokenPath('🙂/x')).toBeNull();
  });

  it('aliases become variable aliases', () => {
    const spec = starterDesignSystem();
    spec.tokens['color.link'] = { type: 'color', value: { ref: 'color.primary' } };
    const v = tokensToVariables(spec);
    expect(v.variables.find((x) => x.path === 'color.link')!.valuesByMode.light).toEqual({
      alias: 'color.primary',
    });
  });
});
