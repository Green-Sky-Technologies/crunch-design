import { describe, expect, it } from 'vitest';
import { dataUrlBytes, effect, gradientPaint, solidPaint } from './paints';

describe('plan -> Figma values', () => {
  it('builds solid paints with alpha as paint opacity', () => {
    expect(solidPaint({ r: 1, g: 0.5, b: 0, a: 0.25 })).toEqual({
      type: 'SOLID',
      color: { r: 1, g: 0.5, b: 0 },
      opacity: 0.25,
      visible: true,
      blendMode: 'NORMAL',
    });
  });

  it('builds gradients and effects', () => {
    const g = gradientPaint({
      type: 'GRADIENT_LINEAR',
      transform: [
        [1, 0, 0],
        [0, 1, 0],
      ],
      stops: [
        { position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
        { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
      ],
    });
    expect(g.type).toBe('GRADIENT_LINEAR');
    expect(g.gradientStops).toHaveLength(2);
    expect(effect({ type: 'LAYER_BLUR', radius: 4 })).toEqual({
      type: 'LAYER_BLUR',
      blurType: 'NORMAL',
      radius: 4,
      visible: true,
    });
    expect(
      effect({
        type: 'INNER_SHADOW',
        radius: 2,
        offset: { x: 0, y: 1 },
        color: { r: 0, g: 0, b: 0, a: 0.1 },
      }),
    ).toMatchObject({ type: 'INNER_SHADOW', radius: 2, spread: 0, offset: { x: 0, y: 1 } });
  });

  it('decodes only raster base64 data URLs', () => {
    const seen: string[] = [];
    const decode = (b: string) => {
      seen.push(b);
      return new Uint8Array([0, 1, 2]);
    };
    expect(dataUrlBytes('data:image/png;base64,AAEC', decode)).toEqual(new Uint8Array([0, 1, 2]));
    expect(seen).toEqual(['AAEC']);
    expect(dataUrlBytes('data:image/svg+xml;base64,AAEC', decode)).toBeNull();
    expect(dataUrlBytes('https://example.com/a.png', decode)).toBeNull();
  });
});
