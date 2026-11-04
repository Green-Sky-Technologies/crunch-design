import { describe, expect, it } from 'vitest';
import { resizeRect, sizingMode, sizingToTailwind } from './sizing';
import { snapMoveRect, snapResizeRect, spacingGuides } from './snap';

const row = { display: 'flex', direction: 'row' as const };
const col = { display: 'flex', direction: 'column' as const };
const block = { display: 'block', direction: 'column' as const };

describe('sizing', () => {
  it('classifies values', () => {
    expect(sizingMode('fill')).toBe('fill');
    expect(sizingMode('hug')).toBe('hug');
    expect(sizingMode(undefined)).toBe('auto');
    expect(sizingMode(120)).toBe('fixed');
    expect(sizingMode({ token: 'space.4' })).toBe('fixed');
  });

  it('maps hug and fill to the Tailwind equivalents of the rendered CSS', () => {
    expect(sizingToTailwind('width', 'hug', row)).toBe('w-fit');
    expect(sizingToTailwind('height', 'hug', row)).toBe('h-fit');
    // main axis of a flex parent: flex-grow 1, basis 0, min 0 (as the renderer emits)
    expect(sizingToTailwind('width', 'fill', row)).toBe('flex-1 basis-0 min-w-0');
    expect(sizingToTailwind('height', 'fill', col)).toBe('flex-1 basis-0 min-h-0');
    // cross axis: stretch
    expect(sizingToTailwind('height', 'fill', row)).toBe('self-stretch');
    expect(sizingToTailwind('width', 'fill', col)).toBe('self-stretch');
    // block parent: 100%
    expect(sizingToTailwind('width', 'fill', block)).toBe('w-full');
    expect(sizingToTailwind('width', 240, block)).toBe('w-[240px]');
    expect(sizingToTailwind('width', '20ch', block)).toBe('w-[20ch]');
    expect(sizingToTailwind('width', { token: 'space.4' }, block)).toBe('w-[var(--space-4)]');
    expect(sizingToTailwind('height', undefined, block)).toBe('h-auto');
  });

  it('resizes from each handle, with aspect lock and a minimum size', () => {
    const r = { x: 10, y: 10, width: 100, height: 50 };
    expect(resizeRect(r, 'e', 20, 99)).toEqual({ x: 10, y: 10, width: 120, height: 50 });
    expect(resizeRect(r, 'nw', 10, 10)).toEqual({ x: 20, y: 20, width: 90, height: 40 });
    expect(resizeRect(r, 'se', 100, 0, true)).toEqual({ x: 10, y: 10, width: 200, height: 100 });
    expect(resizeRect(r, 'e', -500, 0).width).toBe(1);
    expect(resizeRect(r, 'w', 500, 0)).toMatchObject({ width: 1 });
  });
});

describe('spacing guides', () => {
  it('measures the gap to the nearest neighbour on each side, ignoring the parent', () => {
    const r = { x: 100, y: 100, width: 50, height: 20 };
    const parent = { x: 0, y: 0, width: 500, height: 500 };
    const left = { x: 20, y: 90, width: 60, height: 40 }; // gap 20
    const fartherLeft = { x: 0, y: 100, width: 10, height: 20 }; // gap 90
    const below = { x: 110, y: 150, width: 20, height: 20 }; // gap 30
    const unrelated = { x: 300, y: 300, width: 10, height: 10 }; // no overlap on either axis
    const d = spacingGuides(r, [parent, left, fartherLeft, below, unrelated]);
    expect(d.map((x) => x.value).sort((a, b) => a - b)).toEqual([20, 30]);
    const h = d.find((x) => x.value === 20)!;
    expect(h.line).toMatchObject({ x: 80, width: 20, height: 0 });
    const v = d.find((x) => x.value === 30)!;
    expect(v.line).toMatchObject({ y: 120, height: 30, width: 0 });
  });

  it('never reports a sub-pixel gap as a 0 guide', () => {
    const r = { x: 100, y: 100, width: 50, height: 20 };
    const touching = { x: 49.7, y: 100, width: 50, height: 20 }; // gap 0.3
    expect(spacingGuides(r, [touching])).toEqual([]);
  });
});

describe('smart guides', () => {
  const sibling = { x: 0, y: 0, width: 100, height: 40 };
  it('snaps a moving rect to sibling edges and centres', () => {
    const r = snapMoveRect({ x: 3, y: 60, width: 50, height: 20 }, [sibling], 5);
    expect(r.rect.x).toBe(0);
    expect(r.lines).toEqual([{ x: 0, y: 0, width: 0, height: 80 }]);
    const c = snapMoveRect({ x: 23, y: 60, width: 50, height: 20 }, [sibling], 5);
    expect(c.rect.x).toBe(25); // centres align at 50
    expect(snapMoveRect({ x: 35, y: 60, width: 50, height: 20 }, [sibling], 5).lines).toEqual([]);
  });

  it('snaps only the edges a resize handle moves', () => {
    const r = snapResizeRect({ x: 0, y: 60, width: 97, height: 20 }, 'e', [sibling], 5);
    expect(r.rect.width).toBe(100);
    expect(r.lines).toHaveLength(1);
    const w = snapResizeRect({ x: 4, y: 60, width: 96, height: 20 }, 'w', [sibling], 5);
    expect(w.rect).toMatchObject({ x: 0, width: 100 });
    const s = snapResizeRect({ x: 200, y: 0, width: 10, height: 38 }, 's', [sibling], 5);
    expect(s.rect.height).toBe(40);
  });
});
