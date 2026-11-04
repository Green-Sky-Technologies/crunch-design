import { STYLE_PROP_NAMES, starterDesignSystem, validateStyleValue } from '@crunch/doc-model';
import { describe, expect, it } from 'vitest';
import {
  formatStyleValue,
  inspectorGroups,
  isEnumProp,
  isNumericProp,
  nudge,
  parseStyleInput,
  propKeywords,
  propState,
  sharedValue,
  tokensForProp,
} from './inspector';

describe('inspector model', () => {
  it('covers every allowlisted StyleProp exactly once', () => {
    const listed = inspectorGroups().flatMap((g) => g.props);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...STYLE_PROP_NAMES].sort());
  });

  it('knows enum props, keyword props and numeric props', () => {
    expect(isEnumProp('display')).toBe(true);
    expect(propKeywords('display')).toContain('grid');
    expect(isEnumProp('width')).toBe(false);
    expect(propKeywords('width')).toEqual(expect.arrayContaining(['auto', 'hug', 'fill']));
    expect(isNumericProp('gap')).toBe(true);
    expect(isNumericProp('opacity')).toBe(true);
    expect(isNumericProp('display')).toBe(false);
    expect(isNumericProp('gridTemplateColumns')).toBe(false);
  });

  it('every enum option and keyword is a valid value for its prop', () => {
    for (const p of STYLE_PROP_NAMES)
      for (const k of propKeywords(p))
        expect(validateStyleValue(p, k).success, `${p}=${k}`).toBe(true);
  });

  it('parses inputs: numbers and px to numbers, lengths and keywords as strings, empty unsets', () => {
    expect(parseStyleInput('gap', '12')).toEqual({ ok: true, value: 12 });
    expect(parseStyleInput('gap', '12px')).toEqual({ ok: true, value: 12 });
    expect(parseStyleInput('gap', '1.5rem')).toEqual({ ok: true, value: '1.5rem' });
    expect(parseStyleInput('width', 'fill')).toEqual({ ok: true, value: 'fill' });
    expect(parseStyleInput('opacity', '0.5')).toEqual({ ok: true, value: 0.5 });
    expect(parseStyleInput('gap', '')).toEqual({ ok: true, value: null });
    expect(parseStyleInput('gap', 'red').ok).toBe(false);
    expect(parseStyleInput('opacity', '2').ok).toBe(false);
    expect(parseStyleInput('backgroundColor', '#ff0000')).toEqual({ ok: true, value: '#ff0000' });
    expect(parseStyleInput('backgroundColor', 'url(x)').ok).toBe(false);
  });

  it('nudges numbers and lengths, keeping units', () => {
    expect(nudge('gap', 8, 1)).toBe(9);
    expect(nudge('gap', undefined, 10)).toBe(10);
    expect(nudge('gap', '1rem', 1)).toBe('2rem');
    expect(nudge('opacity', 0.5, 1)).toBe(0.6);
    expect(nudge('opacity', 1, 1)).toBeNull();
    expect(nudge('width', 'fill', 1)).toBeNull();
  });

  it('filters tokens by the prop kinds and resolves them', () => {
    const ds = starterDesignSystem();
    const colors = tokensForProp('backgroundColor', ds);
    expect(colors.length).toBeGreaterThan(3);
    expect(colors.every((t) => t.type === 'color')).toBe(true);
    expect(colors.find((t) => t.path === 'color.primary')?.resolved).toBe('#4f46e5');
    expect(
      tokensForProp('fontSize', ds).every((t) => ['fontSize', 'dimension'].includes(t.type)),
    ).toBe(true);
    expect(tokensForProp('display', ds)).toEqual([]);
  });

  it('reports where a breakpoint value comes from', () => {
    const style = { base: { gap: 4 }, lg: { gap: 16 } };
    expect(propState(style, 'gap', 'base')).toMatchObject({
      value: 4,
      from: 'base',
      setHere: true,
    });
    expect(propState(style, 'gap', 'md')).toMatchObject({
      value: 4,
      from: 'base',
      inherited: true,
    });
    expect(propState(style, 'gap', 'lg')).toMatchObject({
      value: 16,
      setHere: true,
      setAt: ['base', 'lg'],
    });
    expect(propState({}, 'gap', 'lg')).toMatchObject({
      value: undefined,
      from: null,
      inherited: false,
    });
    expect(sharedValue([style, { base: { gap: 4 } }], 'gap', 'md')).toBe('same');
    expect(sharedValue([style, { base: { gap: 4 } }], 'gap', 'lg')).toBe('mixed');
    expect(formatStyleValue({ token: 'space.4' })).toBe('space.4');
    expect(formatStyleValue(12)).toBe('12');
  });
});
