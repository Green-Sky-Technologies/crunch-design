import { applyOps, checkInvariants, sampleLandingDoc } from '@crunch/doc-model';
import { describe, expect, it } from 'vitest';
import {
  absolutePlacementOps,
  canDropInto,
  dropIndex,
  dropLine,
  moveOps,
  subtreeSet,
  toFlowOps,
  widthToPin,
} from './dnd';

const doc = sampleLandingDoc();
const kids = (id: string) => doc.nodes[id]!.children;

describe('drop index', () => {
  const col = [
    { id: 'a', rect: { x: 0, y: 0, width: 100, height: 20 } },
    { id: 'b', rect: { x: 0, y: 30, width: 100, height: 20 } },
    { id: 'c', rect: { x: 0, y: 60, width: 100, height: 20 } },
  ];
  it('follows the main axis of a column', () => {
    expect(dropIndex(col, { x: 50, y: -5 }, { direction: 'column' })).toBe(0);
    expect(dropIndex(col, { x: 50, y: 15 }, { direction: 'column' })).toBe(1);
    expect(dropIndex(col, { x: 50, y: 45 }, { direction: 'column' })).toBe(2);
    expect(dropIndex(col, { x: 50, y: 99 }, { direction: 'column' })).toBe(3);
  });

  it('handles wrapping rows and grids row-major', () => {
    const grid = [
      { id: 'a', rect: { x: 0, y: 0, width: 50, height: 20 } },
      { id: 'b', rect: { x: 60, y: 0, width: 50, height: 20 } },
      { id: 'c', rect: { x: 0, y: 30, width: 50, height: 20 } },
      { id: 'd', rect: { x: 60, y: 30, width: 50, height: 20 } },
    ];
    expect(dropIndex(grid, { x: 10, y: 10 }, { direction: 'row' })).toBe(0);
    expect(dropIndex(grid, { x: 40, y: 10 }, { direction: 'row' })).toBe(1);
    expect(dropIndex(grid, { x: 100, y: 10 }, { direction: 'row' })).toBe(2);
    expect(dropIndex(grid, { x: 10, y: 40 }, { direction: 'row' })).toBe(2);
    expect(dropIndex(grid, { x: 100, y: 40 }, { direction: 'row' })).toBe(4);
  });

  it('draws the line between siblings or inside an empty container', () => {
    expect(
      dropLine(col, 1, { x: 0, y: 0, width: 100, height: 80 }, { direction: 'column' }),
    ).toEqual({
      x: 0,
      y: 24,
      width: 100,
      height: 2,
    });
    expect(
      dropLine(col, 3, { x: 0, y: 0, width: 100, height: 80 }, { direction: 'column' }).y,
    ).toBe(79);
    const row = col.map((c, i) => ({ ...c, rect: { x: i * 60, y: 0, width: 50, height: 20 } }));
    expect(
      dropLine(row, 1, { x: 0, y: 0, width: 200, height: 20 }, { direction: 'row' }),
    ).toMatchObject({
      x: 54,
      width: 2,
      height: 20,
    });
    expect(
      dropLine([], 0, { x: 10, y: 10, width: 100, height: 50 }, { direction: 'column' }),
    ).toEqual({
      x: 14,
      y: 14,
      width: 92,
      height: 2,
    });
  });
});

describe('move ops', () => {
  it('reorders within a parent (index is after removal)', () => {
    const ops = moveOps(doc, ['n_herotitle1'], 'n_hero000001', null);
    const next = applyOps(doc, ops).doc;
    expect(next.nodes['n_hero000001']!.children).toEqual([
      'n_herobody01',
      'n_herocta001',
      'n_herotitle1',
    ]);
    const back = moveOps(next, ['n_herotitle1'], 'n_hero000001', 'n_herobody01');
    expect(applyOps(next, back).doc.nodes['n_hero000001']!.children).toEqual(kids('n_hero000001'));
  });

  it('reparents into another container and keeps multi-selections in order', () => {
    const ops = moveOps(doc, ['n_herotitle1', 'n_herocta001'], 'n_feat1card00', 'n_feat1body00');
    const next = applyOps(doc, ops).doc;
    expect(checkInvariants(next)).toEqual([]);
    expect(next.nodes['n_feat1card00']!.children).toEqual([
      'n_feat1title0',
      'n_herotitle1',
      'n_herocta001',
      'n_feat1body00',
    ]);
    expect(next.nodes['n_hero000001']!.children).toEqual(['n_herobody01']);
  });

  it('refuses drops into leaves or into the dragged subtree, and skips no-ops', () => {
    expect(canDropInto(doc, ['n_hero000001'], 'n_herotitle1')).toBe(false); // text is a leaf
    expect(canDropInto(doc, ['n_hero000001'], 'n_hero000001')).toBe(false);
    expect(canDropInto(doc, ['n_root000001'], 'n_hero000001')).toBe(false);
    expect(moveOps(doc, ['n_features01'], 'n_feat1card00', null)).toEqual([]);
    expect(moveOps(doc, ['n_herotitle1'], 'n_hero000001', 'n_herobody01')).toEqual([]);
    expect(subtreeSet(doc, ['n_hero000001']).has('n_herocta001')).toBe(true);
  });
});

describe('absolute placement (breakpoint-safe)', () => {
  it('converting at a non-base breakpoint writes base insets and width and clears overrides', () => {
    // a node that already has lg overrides for width and an inset
    const prepared = applyOps(doc, [
      { op: 'setStyle', id: 'n_herobody01', breakpoint: 'lg', prop: 'width', value: 'fill' },
      { op: 'setStyle', id: 'n_herobody01', breakpoint: 'md', prop: 'top', value: 5 },
    ]).doc;
    const ops = absolutePlacementOps(
      prepared,
      'n_herobody01',
      'lg',
      { left: 10.4, top: 20.6 },
      { width: 400 },
    );
    const n = applyOps(prepared, ops).doc.nodes['n_herobody01']!;
    expect(n.positioning).toBe('absolute');
    expect(n.style.base).toMatchObject({ left: 10, top: 21, width: 400 });
    // every breakpoint resolves to a position and the pinned width
    expect(n.style.md?.top).toBeUndefined();
    expect(n.style.lg?.width).toBeUndefined();
    expect(n.style.lg?.left).toBeUndefined();
  });

  it('moving an already-absolute node writes the given breakpoint', () => {
    const abs = applyOps(
      doc,
      absolutePlacementOps(doc, 'n_herobody01', 'lg', { left: 1, top: 2 }),
    ).doc;
    const moved = applyOps(
      abs,
      absolutePlacementOps(abs, 'n_herobody01', 'lg', { left: 50, top: 60 }),
    ).doc;
    const n = moved.nodes['n_herobody01']!;
    expect(n.style.base).toMatchObject({ left: 1, top: 2 });
    expect(n.style.lg).toMatchObject({ left: 50, top: 60 });
    expect(absolutePlacementOps(doc, 'n_root000001', 'lg', { left: 1, top: 2 })).toEqual([]);
  });

  it('returning to flow clears insets everywhere and restores the pinned width', () => {
    const pin = widthToPin(doc, 'n_herobody01');
    expect(pin).toEqual({ previous: null }); // no width before
    const abs = applyOps(
      doc,
      absolutePlacementOps(doc, 'n_herobody01', 'md', { left: 1, top: 2 }, { width: 300 }),
    ).doc;
    const moved = applyOps(
      abs,
      absolutePlacementOps(abs, 'n_herobody01', 'lg', { left: 9, top: 9 }),
    ).doc;
    const flow = applyOps(moved, toFlowOps(moved, 'n_herobody01', pin!)).doc.nodes['n_herobody01']!;
    expect(flow.positioning).toBe('flow');
    expect(flow.style.base?.width).toBeUndefined();
    expect(flow.style.base?.left).toBeUndefined();
    expect(flow.style.lg?.left).toBeUndefined();
    // a fixed width needs no pin
    const fixed = applyOps(doc, [
      { op: 'setStyle', id: 'n_herobody01', breakpoint: 'base', prop: 'width', value: 200 },
    ]).doc;
    expect(widthToPin(fixed, 'n_herobody01')).toBeNull();
  });
});
