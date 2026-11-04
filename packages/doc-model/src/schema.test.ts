import { describe, expect, it } from 'vitest';
import {
  backgroundImage,
  boxShadow,
  checkInvariants,
  color,
  designSystemSpec,
  DocValidationError,
  frameOf,
  gridTemplate,
  length,
  parseDoc,
  resolveAt,
  resolveToken,
  safeHref,
  safeImageSrc,
  sampleLandingDoc,
  starterDesignSystem,
  styleProps,
  svgMarkup,
  tokenCssVar,
  validateStyleValue,
} from './index';

describe('value grammar rejects CSS/markup injection', () => {
  it.each([
    ['red; background: url(x)'],
    ['#fff}body{display:none'],
    ['expression(alert(1))'],
    ['rgb(0,0,0);x'],
  ])('color %s', (bad) => expect(color.safeParse(bad).success).toBe(false));

  it('accepts real colors', () => {
    for (const ok of [
      '#fff',
      '#4f46e5',
      '#00000080',
      'rgb(1 2 3 / 50%)',
      'oklch(0.7 0.1 250)',
      'transparent',
    ]) {
      expect(color.safeParse(ok).success, ok).toBe(true);
    }
  });

  it('lengths', () => {
    expect(length.safeParse(16).success).toBe(true);
    expect(length.safeParse('1.5rem').success).toBe(true);
    expect(length.safeParse('-2px').success).toBe(true);
    expect(length.safeParse('calc(100% - 1px)').success).toBe(false);
    expect(length.safeParse('10px;').success).toBe(false);
  });

  it('shadows and gradients', () => {
    expect(boxShadow.safeParse('0 1px 2px rgba(0,0,0,0.06), 0 4px 12px #0000001a').success).toBe(
      true,
    );
    expect(boxShadow.safeParse('0 0 0 url(x)').success).toBe(false);
    expect(backgroundImage.safeParse('linear-gradient(90deg, #fff, #000 50%)').success).toBe(true);
    expect(backgroundImage.safeParse('url(https://evil.example/x.png)').success).toBe(false);
  });

  it('grid templates', () => {
    expect(gridTemplate.safeParse('repeat(3, minmax(0, 1fr))').success).toBe(true);
    expect(gridTemplate.safeParse('200px 1fr auto').success).toBe(true);
    expect(gridTemplate.safeParse('repeat(3, 1fr)) ; x').success).toBe(false);
    expect(gridTemplate.safeParse('url(x)').success).toBe(false);
  });

  it('urls', () => {
    expect(safeImageSrc.safeParse('https://images.example.com/a.png').success).toBe(true);
    expect(safeImageSrc.safeParse('javascript:alert(1)').success).toBe(false);
    expect(safeImageSrc.safeParse('data:image/svg+xml;base64,PHN2Zz4=').success).toBe(false);
    expect(safeHref.safeParse('javascript:alert(1)').success).toBe(false);
    expect(safeHref.safeParse('#pricing').success).toBe(true);
  });

  it('svg', () => {
    expect(svgMarkup.safeParse('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>').success).toBe(true);
    expect(svgMarkup.safeParse('<svg onload="x()"></svg>').success).toBe(false);
    expect(svgMarkup.safeParse('<svg><script>x</script></svg>').success).toBe(false);
    expect(svgMarkup.safeParse('<svg><foreignObject/></svg>').success).toBe(false);
  });
});

describe('style props', () => {
  it('accepts literals and token refs, rejects unknown props', () => {
    expect(styleProps.safeParse({ paddingTop: 8, color: { token: 'color.primary' } }).success).toBe(
      true,
    );
    expect(styleProps.safeParse({ webkitWhatever: 1 }).success).toBe(false);
    expect(validateStyleValue('width', 'hug').success).toBe(true);
    expect(validateStyleValue('nope', 1).success).toBe(false);
    expect(validateStyleValue('display', 'table').success).toBe(false);
  });

  it('resolves mobile-first breakpoints', () => {
    const s = { base: { fontSize: 16 }, lg: { fontSize: 24 } };
    expect(resolveAt(s, 'fontSize', 'base')).toEqual({ value: 16, from: 'base' });
    expect(resolveAt(s, 'fontSize', 'md')).toEqual({ value: 16, from: 'base' });
    expect(resolveAt(s, 'fontSize', 'lg')).toEqual({ value: 24, from: 'lg' });
  });
});

describe('DesignDoc', () => {
  it('sample doc is valid', () => {
    const doc = parseDoc(sampleLandingDoc());
    expect(Object.keys(doc.nodes).length).toBeGreaterThan(10);
    expect(frameOf(doc, 'n_feat2title0')?.id).toBe('f_desktop001');
  });

  it('detects broken parent/child links, orphans and leaf children', () => {
    const doc = sampleLandingDoc();
    doc.nodes['n_hero000001']!.children.push('n_logo000001'); // logo now has two parents' claims
    const text = doc.nodes['n_herotitle1']!;
    text.children = ['n_herobody01'];
    const issues = checkInvariants(doc)
      .map((i) => i.message)
      .join('\n');
    expect(issues).toMatch(/does not point back/);
    expect(issues).toMatch(/cannot have children/);

    const orphaned = sampleLandingDoc();
    orphaned.nodes['n_root000001']!.children = orphaned.nodes['n_root000001']!.children.filter(
      (c) => c !== 'n_nav0000001',
    );
    expect(checkInvariants(orphaned).some((i) => /does not list/.test(i.message))).toBe(true);
  });

  it('parseDoc throws a typed error with issues', () => {
    const bad = sampleLandingDoc();
    (bad.nodes['n_logo000001']!.style.base as Record<string, unknown>).color = 'red;}';
    expect(() => parseDoc(bad)).toThrow(DocValidationError);
  });
});

describe('design system', () => {
  it('starter design system is valid and resolves tokens with themes', () => {
    const ds = designSystemSpec.parse(starterDesignSystem());
    expect(resolveToken(ds.tokens, 'color.text')).toBe('#18181b');
    expect(resolveToken(ds.tokens, 'color.text', ds.themes.dark)).toBe('#f4f4f5');
    expect(tokenCssVar('color.primaryText')).toBe('--color-primaryText');
  });

  it('follows aliases and detects cycles', () => {
    const tokens = {
      'color.brand': { type: 'color' as const, value: '#123456' },
      'color.link': { type: 'color' as const, value: { ref: 'color.brand' } },
      'color.a': { type: 'color' as const, value: { ref: 'color.b' } },
      'color.b': { type: 'color' as const, value: { ref: 'color.a' } },
    };
    expect(resolveToken(tokens, 'color.link')).toBe('#123456');
    expect(() => resolveToken(tokens, 'color.a')).toThrow(/cycle/);
  });

  it('rejects invalid token values', () => {
    const ds = starterDesignSystem();
    ds.tokens['color.bad'] = { type: 'color', value: 'red;}' };
    expect(designSystemSpec.safeParse(ds).success).toBe(false);
  });
});
