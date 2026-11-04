import { applyOps, sampleLandingDoc } from '@crunch/doc-model';
import { describe, expect, it } from 'vitest';
import {
  ancestors,
  firstChild,
  isLocked,
  layerName,
  layerRows,
  nodeLabel,
  nodeTag,
  parentOf,
  selectableAt,
  sibling,
  textPreview,
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

describe('layer names (edit panel tree)', () => {
  const box = (style: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({
      id: 'n_x00000001',
      type: 'box',
      tag: 'div',
      parentId: null,
      children: [],
      positioning: 'flow',
      props: {},
      style,
      ...extra,
    }) as unknown as Parameters<typeof layerName>[0];

  it('names boxes by the layout they establish, before their name', () => {
    expect(layerName(box({ base: { display: 'flex' } }))).toBe('Row'); // CSS default direction
    expect(layerName(box({ base: { display: 'flex', flexDirection: 'column' } }))).toBe('Column');
    expect(layerName(box({ base: { display: 'inline-flex', flexDirection: 'row-reverse' } }))).toBe(
      'Row',
    );
    expect(layerName(box({ base: { display: 'grid' } }, { name: 'Cards' }))).toBe('Grid');
    // the widest breakpoint's layout wins (that's what desktop frames show)
    expect(
      layerName(
        box({ base: { display: 'flex', flexDirection: 'column' }, lg: { flexDirection: 'row' } }),
      ),
    ).toBe('Row');
  });

  it('falls back to the name, then the capitalised tag', () => {
    expect(layerName(box({}, { name: 'Hero' }))).toBe('Hero');
    expect(layerName(box({}, { tag: 'header' }))).toBe('Header');
    expect(layerName(box({}, { tag: 'a' }))).toBe('Link');
    expect(layerName(box({}))).toBe('Box');
    expect(layerName(doc.nodes['n_feat2title0']!)).toBe('Heading');
    expect(layerName(doc.nodes['n_feat2body00']!)).toBe('Paragraph');
    expect(layerName(doc.nodes['n_herotitle1']!)).toBe('Headline');
    expect(layerName(doc.nodes['n_root000001']!)).toBe('Column');
    expect(layerName(doc.nodes['n_features01']!)).toBe('Grid');
  });

  it('shows tags and quoted, truncated text previews', () => {
    expect(nodeTag(doc.nodes['n_herotitle1']!)).toBe('h1');
    expect(nodeTag(doc.nodes['n_herocta001']!)).toBe('component');
    expect(textPreview(doc.nodes['n_feat2title0']!)).toBe('“Your design system”');
    expect(textPreview(doc.nodes['n_herobody01']!, 12)).toMatch(/^“.{11}…”$/);
    expect(textPreview(doc.nodes['n_hero000001']!)).toBe('');
  });
});
