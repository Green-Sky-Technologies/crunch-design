import { describe, expect, it } from 'vitest';
import { applyOps, sampleLandingDoc, type Slider } from '@crunch/doc-model';
import { mapBinding, sliderOps, snap } from './sliders';

const density: Slider = {
  id: 's_density001',
  label: 'Density',
  min: 0,
  max: 10,
  step: 1,
  value: 5,
  pinned: false,
  createdBy: 'agent',
  bindings: [
    {
      target: { nodeId: 'n_features01', prop: 'gap', breakpoint: 'base' },
      map: { type: 'linear', from: 4, to: 44, unit: 'px' },
    },
    {
      target: { nodeId: 'n_hero000001', prop: 'paddingTop', breakpoint: 'md' },
      map: { type: 'linear', from: 1, to: 3, unit: 'rem' },
    },
    {
      target: { token: 'radius.lg' },
      map: {
        type: 'stops',
        stops: [
          [0, '0px'],
          [5, '8px'],
          [10, '24px'],
        ],
      },
    },
  ],
};

describe('slider mapping', () => {
  it('maps linear values with units and steps string stops', () => {
    expect(mapBinding(density, density.bindings[0]!, 0)).toBe(4);
    expect(mapBinding(density, density.bindings[0]!, 10)).toBe(44);
    expect(mapBinding(density, density.bindings[1]!, 5)).toBe('2rem');
    expect(mapBinding(density, density.bindings[2]!, 4)).toBe('0px');
    expect(mapBinding(density, density.bindings[2]!, 5)).toBe('8px');
    expect(
      mapBinding(
        density,
        {
          target: { token: 'x.y' },
          map: {
            type: 'stops',
            stops: [
              [0, 0],
              [10, 100],
            ],
          },
        },
        2.5,
      ),
    ).toBe(25);
    expect(snap(density, 3.4)).toBe(3);
  });

  it('produces ops the reducer accepts: slider value, styles and token overrides', () => {
    const doc = { ...sampleLandingDoc(), sliders: [density] };
    const ops = sliderOps(doc, density, 10);
    expect(ops.map((o) => o.op)).toEqual([
      'setSliderValue',
      'setStyle',
      'setStyle',
      'setTokenOverride',
    ]);
    const next = applyOps(doc, ops).doc;
    expect(next.sliders[0]!.value).toBe(10);
    expect(next.nodes['n_features01']!.style.base?.gap).toBe(44);
    expect(next.nodes['n_hero000001']!.style.md?.paddingTop).toBe('3rem');
    expect(next.tokenOverrides['radius.lg']).toBe('24px');
  });

  it('clamps and skips bindings to missing nodes or invalid values', () => {
    const doc = { ...sampleLandingDoc(), sliders: [density] };
    const broken: Slider = {
      ...density,
      bindings: [
        {
          target: { nodeId: 'n_gone0000001', prop: 'gap', breakpoint: 'base' },
          map: { type: 'linear', from: 0, to: 1, unit: 'px' },
        },
        {
          target: { nodeId: 'n_features01', prop: 'opacity', breakpoint: 'base' },
          map: { type: 'linear', from: 0, to: 5, unit: '' },
        },
      ],
    };
    const ops = sliderOps(doc, broken, 99);
    expect(ops[0]).toEqual({ op: 'setSliderValue', id: density.id, value: 10 });
    expect(ops).toHaveLength(1); // opacity 5 is out of range, node missing
  });
});
