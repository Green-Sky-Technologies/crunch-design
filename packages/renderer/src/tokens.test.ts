import { starterDesignSystem } from '@crunch/doc-model';
import { describe, expect, it } from 'vitest';
import { compileTokens, tokensToCss } from './tokens';

describe('compileTokens', () => {
  const ds = starterDesignSystem();

  it('emits a var for every token with correct units', () => {
    const c = compileTokens(ds);
    expect(c.vars['--color-primary']).toBe('#4f46e5');
    expect(c.vars['--weight-bold']).toBe('700');
    expect(c.vars['--leading-tight']).toBe('1.15');
    expect(c.vars['--space-4']).toBe('1rem');
    expect(Object.keys(c.vars)).toHaveLength(Object.keys(ds.tokens).length);
  });

  it('keeps aliases live as var() references', () => {
    const c = compileTokens({
      tokens: { ...ds.tokens, 'color.link': { type: 'color', value: { ref: 'color.primary' } } },
      themes: {},
    });
    expect(c.vars['--color-link']).toBe('var(--color-primary)');
  });

  it('applies valid overrides and rejects invalid or unknown ones', () => {
    const c = compileTokens(ds, {
      'color.primary': '#ff0066',
      'space.4': 20,
      'color.text': 'red;}',
      'color.nope': '#fff',
    });
    expect(c.vars['--color-primary']).toBe('#ff0066');
    expect(c.vars['--space-4']).toBe('20px');
    expect(c.vars['--color-text']).toBe('#18181b');
    expect(c.warnings).toHaveLength(2);
  });

  it('emits theme blocks and deterministic CSS', () => {
    const css = tokensToCss(compileTokens(ds), '.cd-frame');
    expect(css).toContain('.cd-frame[data-theme="dark"]{');
    expect(css).toContain('--color-background:#0b0b0f;');
    expect(tokensToCss(compileTokens(ds), '.cd-frame')).toBe(css);
    expect(css).not.toMatch(/[<>]/);
  });
});
