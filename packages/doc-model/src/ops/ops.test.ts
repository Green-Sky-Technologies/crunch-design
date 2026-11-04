import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyOps,
  checkInvariants,
  LEAF_TYPES,
  newId,
  OpError,
  sampleLandingDoc,
  touchedNodeIds,
  type DesignDoc,
  type DocOp,
  type Node,
} from '../index';

const text = (id: string, parentId: string, t = 'Hello'): Node => ({
  id,
  type: 'text',
  tag: 'p',
  parentId,
  children: [],
  positioning: 'flow',
  style: {},
  props: { text: t },
});

describe('ops: unit behavior', () => {
  it('setStyle validates values and unset round-trips', () => {
    const doc = sampleLandingDoc();
    const { doc: a, inverse } = applyOps(doc, [
      { op: 'setStyle', id: 'n_herotitle1', breakpoint: 'md', prop: 'fontSize', value: '3rem' },
    ]);
    expect(a.nodes['n_herotitle1']!.style.md?.fontSize).toBe('3rem');
    expect(applyOps(a, inverse).doc).toEqual(doc);
    expect(() =>
      applyOps(doc, [
        { op: 'setStyle', id: 'n_herotitle1', breakpoint: 'base', prop: 'color', value: 'red;}' },
      ]),
    ).toThrow(OpError);
    expect(() =>
      applyOps(doc, [
        { op: 'setStyle', id: 'n_herotitle1', breakpoint: 'base', prop: 'behavior', value: 1 },
      ]),
    ).toThrow(/Unknown style prop|behavior/);
  });

  it('keeps identity of untouched nodes (structural sharing)', () => {
    const doc = sampleLandingDoc();
    const { doc: a } = applyOps(doc, [
      { op: 'setProps', id: 'n_herotitle1', patch: { text: 'New headline' } },
    ]);
    expect(a.nodes['n_herotitle1']).not.toBe(doc.nodes['n_herotitle1']);
    expect(a.nodes['n_herobody01']).toBe(doc.nodes['n_herobody01']);
    expect(a.nodes['n_features01']).toBe(doc.nodes['n_features01']);
  });

  it('rejects moves into own subtree, into leaves, and removing roots', () => {
    const doc = sampleLandingDoc();
    expect(() =>
      applyOps(doc, [{ op: 'moveNode', id: 'n_hero000001', parentId: 'n_herotitle1', index: 0 }]),
    ).toThrow(/cannot have children|cycle|itself/);
    expect(() =>
      applyOps(doc, [{ op: 'moveNode', id: 'n_root000001', parentId: 'n_hero000001', index: 0 }]),
    ).toThrow(/frame root/);
    expect(() =>
      applyOps(doc, [{ op: 'moveNode', id: 'n_hero000001', parentId: 'n_hero000001', index: 0 }]),
    ).toThrow(/itself/);
    expect(() => applyOps(doc, [{ op: 'removeNode', id: 'n_root000001' }])).toThrow(/frame root/);
  });

  it('transactions are atomic', () => {
    const doc = sampleLandingDoc();
    const before = structuredClone(doc);
    expect(() =>
      applyOps(doc, [
        { op: 'setProps', id: 'n_herotitle1', patch: { text: 'changed' } },
        { op: 'removeNode', id: 'n_doesnotexist' },
      ]),
    ).toThrow(/Op 1/);
    expect(doc).toEqual(before);
  });

  it('insertSubtree rejects inconsistent or duplicate subtrees and invalid props', () => {
    const doc = sampleLandingDoc();
    expect(() =>
      applyOps(doc, [
        {
          op: 'insertSubtree',
          parentId: 'n_hero000001',
          index: 0,
          nodes: [text('n_logo000001', 'n_hero000001')],
        },
      ]),
    ).toThrow(/exists/);
    const bad = text('n_newnode0001', 'n_hero000001');
    (bad.props as Record<string, unknown>).href = 'javascript:alert(1)';
    expect(() =>
      applyOps(doc, [{ op: 'insertSubtree', parentId: 'n_hero000001', index: 0, nodes: [bad] }]),
    ).toThrow(OpError);
  });

  it('frames: insert, update, move, remove round-trip', () => {
    const doc = sampleLandingDoc();
    const root: Node = {
      id: 'n_mobroot001',
      type: 'box',
      tag: 'main',
      parentId: null,
      children: ['n_mobtext001'],
      positioning: 'flow',
      style: {},
      props: {},
    };
    const ops: DocOp[] = [
      {
        op: 'insertFrame',
        index: 1,
        frame: {
          id: 'f_mobile0001',
          name: 'Mobile',
          rootNodeId: root.id,
          canvas: { x: 1400, y: 0 },
          width: 390,
          height: 'auto',
          previewBreakpoints: [],
        },
        nodes: [root, text('n_mobtext001', root.id)],
      },
      { op: 'updateFrame', id: 'f_mobile0001', patch: { width: 414, name: 'Mobile L' } },
      { op: 'moveFrame', id: 'f_mobile0001', index: 0 },
    ];
    const { doc: a, inverse } = applyOps(doc, ops);
    expect(a.frames.map((f) => f.id)).toEqual(['f_mobile0001', 'f_desktop001']);
    expect(checkInvariants(a)).toEqual([]);
    expect(applyOps(a, inverse).doc).toEqual(doc);
    const { doc: b, inverse: inv2 } = applyOps(a, [{ op: 'removeFrame', id: 'f_mobile0001' }]);
    expect(b.nodes['n_mobtext001']).toBeUndefined();
    expect(applyOps(b, inv2).doc).toEqual(a);
  });

  it('instances, sliders and token overrides round-trip', () => {
    const doc = sampleLandingDoc();
    const ops: DocOp[] = [
      {
        op: 'setInstance',
        id: 'n_herocta001',
        variant: { variant: 'secondary' },
        values: { label: 'Try it' },
      },
      {
        op: 'upsertSlider',
        slider: {
          id: 's_density001',
          label: 'Density',
          min: 0,
          max: 10,
          step: 1,
          value: 4,
          pinned: false,
          createdBy: 'agent',
          bindings: [
            {
              target: { nodeId: 'n_features01', prop: 'gap', breakpoint: 'base' },
              map: { type: 'linear', from: 8, to: 48, unit: 'px' },
            },
          ],
        },
      },
      { op: 'setSliderValue', id: 's_density001', value: 7 },
      { op: 'setTokenOverride', path: 'color.primary', value: '#ff0066' },
    ];
    const { doc: a, inverse } = applyOps(doc, ops);
    expect(a.sliders[0]!.value).toBe(7);
    expect(a.tokenOverrides['color.primary']).toBe('#ff0066');
    expect(applyOps(a, inverse).doc).toEqual(doc);
    expect(() => applyOps(a, [{ op: 'setSliderValue', id: 's_density001', value: 99 }])).toThrow(
      /range/,
    );
  });

  it('touchedNodeIds', () => {
    expect(
      touchedNodeIds({ op: 'moveNode', id: 'n_a00000', parentId: 'n_b00000', index: 0 }),
    ).toEqual(['n_a00000', 'n_b00000']);
  });
});

// ---------------------------------------------------------------------------------------------
// Property tests: random op sequences keep invariants, and inverses restore the original exactly.
// ---------------------------------------------------------------------------------------------

type Intent = { kind: number; a: number; b: number; c: number; v: number };
const intent = fc.record({
  kind: fc.integer({ min: 0, max: 7 }),
  a: fc.nat(),
  b: fc.nat(),
  c: fc.nat(),
  v: fc.integer({ min: 0, max: 64 }),
});

/** Turn a random intent into a concrete, usually valid, op for the current doc. */
function materialize(doc: DesignDoc, it: Intent): DocOp | null {
  const ids = Object.keys(doc.nodes).sort();
  const pick = (n: number) => ids[n % ids.length]!;
  const containers = ids.filter((id) => !LEAF_TYPES.has(doc.nodes[id]!.type));
  const nonRoots = ids.filter((id) => doc.nodes[id]!.parentId !== null);
  switch (it.kind) {
    case 0:
      return {
        op: 'setStyle',
        id: pick(it.a),
        breakpoint: (['base', 'md', 'lg'] as const)[it.b % 3]!,
        prop: (['paddingTop', 'gap', 'opacity', 'width', 'color'] as const)[it.c % 5]!,
        value: [it.v, it.v / 64, 'hug', '#123456', null][it.c % 5] ?? null,
      };
    case 1: {
      const id = pick(it.a);
      return { op: 'setStyle', id, breakpoint: 'base', prop: 'gap', value: null };
    }
    case 2: {
      if (!nonRoots.length || !containers.length) return null;
      const id = nonRoots[it.a % nonRoots.length]!;
      const parentId = containers[it.b % containers.length]!;
      const target = doc.nodes[parentId]!;
      const sameParent = doc.nodes[id]!.parentId === parentId;
      const max = target.children.length - (sameParent ? 1 : 0);
      return { op: 'moveNode', id, parentId, index: it.c % (max + 1) };
    }
    case 3: {
      if (!nonRoots.length) return null;
      return { op: 'removeNode', id: nonRoots[it.a % nonRoots.length]! };
    }
    case 4: {
      const parentId = containers[it.a % containers.length]!;
      const nid = newId('n');
      return {
        op: 'insertSubtree',
        parentId,
        index: it.b % (doc.nodes[parentId]!.children.length + 1),
        nodes: [text(nid, parentId, `t${it.v}`)],
      };
    }
    case 5: {
      const textIds = ids.filter((id) => doc.nodes[id]!.type === 'text');
      if (!textIds.length) return null;
      return {
        op: 'setProps',
        id: textIds[it.a % textIds.length]!,
        patch: { text: `changed ${it.v}` },
      };
    }
    case 6:
      return {
        op: 'setNodeMeta',
        id: pick(it.a),
        patch: { name: it.v % 2 ? `N${it.v}` : null, hidden: it.v % 3 === 0 ? true : null },
      };
    default:
      return { op: 'setTokenOverride', path: 'space.4', value: it.v % 2 ? `${it.v}px` : null };
  }
}

describe('ops: properties', () => {
  it('random sequences keep invariants and inverse restores the original', () => {
    fc.assert(
      fc.property(fc.array(intent, { minLength: 1, maxLength: 40 }), (intents) => {
        const original = sampleLandingDoc();
        let doc = original;
        const undo: DocOp[][] = [];
        for (const it of intents) {
          const op = materialize(doc, it);
          if (!op) continue;
          try {
            const r = applyOps(doc, [op]);
            expect(checkInvariants(r.doc)).toEqual([]);
            undo.push(r.inverse);
            doc = r.doc;
          } catch (e) {
            // Rejected ops must be OpErrors and must not change the doc.
            expect(e).toBeInstanceOf(OpError);
          }
        }
        for (const inv of undo.reverse()) doc = applyOps(doc, inv).doc;
        expect(doc).toEqual(original);
      }),
      { numRuns: 300 },
    );
  });

  it('a whole batch inverts as a unit', () => {
    fc.assert(
      fc.property(fc.array(intent, { minLength: 1, maxLength: 20 }), (intents) => {
        const original = sampleLandingDoc();
        // Build a valid batch by materializing against the evolving doc.
        let probe = original;
        const batch: DocOp[] = [];
        for (const it of intents) {
          const op = materialize(probe, it);
          if (!op) continue;
          try {
            probe = applyOps(probe, [op]).doc;
            batch.push(op);
          } catch {
            /* skip invalid */
          }
        }
        if (!batch.length) return;
        const { doc, inverse } = applyOps(original, batch);
        expect(doc).toEqual(probe);
        expect(applyOps(doc, inverse).doc).toEqual(original);
      }),
      { numRuns: 200 },
    );
  });
});
