import { applyOps, parseDoc, sampleLandingDoc, starterDesignSystem } from '@crunch/doc-model';
import { describe, expect, it } from 'vitest';
import { buildInsertNode, insertNodeOps, simplifyStroke, type InsertSpec } from './insert';

const ds = starterDesignSystem();
const doc = sampleLandingDoc();

describe('insert tools', () => {
  it('builds flow nodes with tool defaults, token-aware', () => {
    const rect = buildInsertNode({ tool: 'rect' }, 'n_hero000001', ds)!;
    expect(rect).toMatchObject({ type: 'box', tag: 'div', positioning: 'flow' });
    expect(rect.style.base).toMatchObject({
      width: 160,
      height: 100,
      backgroundColor: { token: 'color.border' },
    });
    expect(buildInsertNode({ tool: 'ellipse' }, 'n_hero000001', ds)!.style.base).toMatchObject({
      borderRadius: '50%',
    });
    expect(
      buildInsertNode({ tool: 'line', size: { width: 300, height: 1 } }, 'n_hero000001', ds)!.style
        .base,
    ).toMatchObject({ width: 300, height: 1 });
    const text = buildInsertNode({ tool: 'text' }, 'n_hero000001', ds)!;
    expect(text).toMatchObject({ type: 'text', tag: 'p', props: { text: 'Text' } });
    // without the token, literals are used
    const bare = { ...ds, tokens: {} };
    expect(
      buildInsertNode({ tool: 'rect' }, 'n_hero000001', bare)!.style.base?.backgroundColor,
    ).toBe('#d4d4d8');
  });

  it('places absolutely only when asked, and needs a src / known component', () => {
    const abs = buildInsertNode(
      { tool: 'box', at: { left: 10.4, top: 20.6 }, size: { width: 50, height: 40 } },
      'n_hero000001',
      ds,
    )!;
    expect(abs.positioning).toBe('absolute');
    expect(abs.style.base).toMatchObject({ left: 10, top: 21, width: 50, height: 40 });
    expect(buildInsertNode({ tool: 'image' }, 'n_hero000001', ds)).toBeNull();
    expect(
      buildInsertNode({ tool: 'component', componentId: 'Nope' }, 'n_hero000001', ds),
    ).toBeNull();
    expect(
      buildInsertNode({ tool: 'component', componentId: 'Button' }, 'n_hero000001', ds),
    ).toMatchObject({ type: 'instance', componentRef: { componentId: 'Button', variant: {} } });
  });

  it('produces valid docs for every tool, including vectors', () => {
    const specs: InsertSpec[] = [
      { tool: 'text' },
      { tool: 'box' },
      { tool: 'rect' },
      { tool: 'ellipse' },
      { tool: 'line' },
      { tool: 'image', src: 'https://example.com/a.png' },
      { tool: 'component', componentId: 'Button' },
      {
        tool: 'arrow',
        size: { width: 100, height: 40 },
        points: [
          { x: 6, y: 6 },
          { x: 94, y: 34 },
        ],
      },
      {
        tool: 'pencil',
        at: { left: 0, top: 0 },
        size: { width: 40, height: 40 },
        points: [
          { x: 1, y: 1 },
          { x: 20, y: 30 },
          { x: 39, y: 2 },
        ],
      },
    ];
    let d = doc;
    for (const spec of specs) {
      const r = insertNodeOps(spec, 'n_hero000001', 0, ds)!;
      d = applyOps(d, r.ops).doc;
      expect(d.nodes[r.id]?.parentId).toBe('n_hero000001');
    }
    expect(() => parseDoc(d)).not.toThrow();
    const arrow = Object.values(d.nodes).find((n) => n.type === 'svg' && n.name === 'Arrow')!;
    expect(arrow.type === 'svg' && arrow.props.svg).toMatch(/<line x1="6" y1="6" x2="94" y2="34"/);
  });

  it('simplifies pencil strokes', () => {
    const pts = [0, 0.5, 1, 3, 3.2, 10].map((x) => ({ x, y: 0 }));
    expect(simplifyStroke(pts).map((p) => p.x)).toEqual([0, 3, 10]);
  });
});
