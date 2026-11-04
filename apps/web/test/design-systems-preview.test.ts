import { describe, expect, it } from 'vitest';
import { parseDoc, starterDesignSystem, tokenCssVar } from '@crunch/doc-model';
import { renderFrameStatic } from '@crunch/renderer';
import {
  buildComponentPreviewDoc,
  buildPreviewDoc,
  PREVIEW_FRAME_ID,
  variantCombos,
} from '@/features/design-system/preview-doc';

describe('design-system live preview (Story 4.1)', () => {
  it('renders every token and every component variant', () => {
    const spec = starterDesignSystem();
    spec.tokens['opacity.muted'] = { type: 'number', value: 0.6 };
    spec.tokens['color.link'] = { type: 'color', value: { ref: 'color.primary' } };
    const doc = parseDoc(buildPreviewDoc(spec)); // a valid DesignDoc
    const out = renderFrameStatic(doc, spec, PREVIEW_FRAME_ID);
    const css = out.css;

    for (const path of Object.keys(spec.tokens)) {
      expect(css, path).toContain(`var(${tokenCssVar(path)})`);
      expect(out.html, path).toContain(path);
    }
    // Every component renders once per variant combination.
    const instances = Object.values(doc.nodes).filter((n) => n.type === 'instance');
    expect(instances.map((n) => n.type === 'instance' && n.componentRef)).toEqual([
      { componentId: 'Button', variant: { variant: 'primary' } },
      { componentId: 'Button', variant: { variant: 'secondary' } },
    ]);
    expect(out.html).not.toContain('Missing component');
    expect(out.html).toContain('<button');
  });

  it('handles an empty system and caps variant combinations', () => {
    const spec = starterDesignSystem();
    spec.tokens = {};
    spec.themes = {};
    spec.components = {};
    const doc = parseDoc(buildPreviewDoc(spec));
    expect(renderFrameStatic(doc, spec, PREVIEW_FRAME_ID).html).toContain('Breakpoints');

    const combos = variantCombos({
      a: { options: ['1', '2', '3', '4'], default: '2' },
      b: { options: ['x', 'y', 'z', 'w'], default: 'x' },
    });
    expect(combos).toHaveLength(12);
    expect(combos[0]).toEqual({ a: '2', b: 'x' });
  });

  it('builds a single-instance component preview', () => {
    const spec = starterDesignSystem();
    const doc = parseDoc(
      buildComponentPreviewDoc('Button', { variant: 'secondary' }, { label: 'Go' }),
    );
    const html = renderFrameStatic(doc, spec, doc.frames[0]!.id).html;
    expect(html).toContain('Go');
  });
});
