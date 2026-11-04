import { applyOps, sampleLandingDoc } from '@crunch/doc-model';
import { describe, expect, it } from 'vitest';
import {
  ancestors,
  firstChild,
  isLocked,
  layerRows,
  nodeLabel,
  parentOf,
  selectableAt,
  sibling,
  toggleSelection,
  topLevelSelection,
} from './tree';

const doc = sampleLandingDoc();

describe('tree navigation', () => {
  it('walks up and down the tree', () => {
    expect(ancestors(doc, 'n_herotitle1')).toEqual(['n_hero000001', 'n_root000001']);
    expect(parentOf(doc, 'n_herotitle1')).toBe('n_hero000001');
    expect(parentOf(doc, 'n_root000001')).toBeNull();
    expect(firstChild(doc, 'n_hero000001')).toBe('n_herotitle1');
    expect(firstChild(doc, 'n_herotitle1')).toBeNull();
  });

  it('cycles siblings', () => {
    expect(sibling(doc, 'n_herotitle1', 1)).toBe('n_herobody01');
    expect(sibling(doc, 'n_herotitle1', -1)).toBe('n_herocta001');
    expect(sibling(doc, 'n_root000001', 1)).toBeNull();
  });

  it('skips locked nodes when selecting', () => {
    const locked = applyOps(doc, [
      { op: 'setNodeMeta', id: 'n_herotitle1', patch: { locked: true } },
    ]).doc;
    expect(selectableAt(locked, 'n_herotitle1')).toBe('n_hero000001');
    expect(selectableAt(doc, 'n_herotitle1')).toBe('n_herotitle1');
  });

  it('treats descendants of a locked node as locked', () => {
    const locked = applyOps(doc, [
      { op: 'setNodeMeta', id: 'n_hero000001', patch: { locked: true } },
    ]).doc;
    expect(isLocked(locked, 'n_hero000001')).toBe(true);
    expect(isLocked(locked, 'n_herotitle1')).toBe(true);
    expect(isLocked(locked, 'n_features01')).toBe(false);
    expect(isLocked(doc, 'n_herotitle1')).toBe(false);
  });

  it('toggles multi-selection and reduces it to top-level nodes', () => {
    expect(toggleSelection(['a'], 'b', false)).toEqual(['b']);
    expect(toggleSelection(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(toggleSelection(['a', 'b'], 'a', true)).toEqual(['b']);
    expect(
      topLevelSelection(doc, ['n_hero000001', 'n_herotitle1', 'n_root000001', 'n_features01']),
    ).toEqual(['n_hero000001', 'n_features01']);
  });

  it('builds layer rows honouring expansion', () => {
    const rows = layerRows(doc, 'n_root000001', new Set(['n_root000001', 'n_hero000001']));
    expect(rows[0]).toMatchObject({ id: 'n_root000001', depth: 0, label: 'Page', expanded: true });
    const hero = rows.findIndex((r) => r.id === 'n_hero000001');
    expect(rows[hero + 1]).toMatchObject({ id: 'n_herotitle1', depth: 2, label: 'Headline' });
    expect(rows.some((r) => r.id === 'n_feat1card00')).toBe(false);
    expect(nodeLabel(doc.nodes['n_feat1title0']!)).toBe('Live HTML frames');
    expect(nodeLabel(doc.nodes['n_herocta001']!)).toBe('CTA');
  });
});
