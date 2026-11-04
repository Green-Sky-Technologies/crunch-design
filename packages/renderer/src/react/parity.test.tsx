// @vitest-environment happy-dom
/**
 * Parity: the live DOM renderer and the static renderer must produce the same markup and the
 * same CSS rules for the same doc (Story 2.3 / 7.1 AC foundation).
 */
import { act, cleanup, render } from '@testing-library/react';
import { applyOps, sampleLandingDoc, starterDesignSystem, type DesignDoc } from '@crunch/doc-model';
import { afterEach, describe, expect, it } from 'vitest';
import { renderDocumentHtml, renderFrameStatic } from '../static';
import { FrameView } from './FrameView';

const ds = starterDesignSystem();
afterEach(cleanup);

const svgIcon =
  '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12h14" stroke="currentColor" stroke-width="2"/></svg>';

function richDoc(): DesignDoc {
  return applyOps(sampleLandingDoc(), [
    {
      op: 'insertSubtree',
      parentId: 'n_nav0000001',
      index: 1,
      nodes: [
        {
          id: 'n_icon000001',
          type: 'svg',
          parentId: 'n_nav0000001',
          children: [],
          positioning: 'flow',
          style: { base: { width: 24, height: 24 } },
          props: { svg: svgIcon, ariaLabel: 'Menu' },
        },
      ],
    },
    {
      op: 'insertSubtree',
      parentId: 'n_hero000001',
      index: 0,
      nodes: [
        {
          id: 'n_img0000001',
          type: 'image',
          parentId: 'n_hero000001',
          children: [],
          positioning: 'absolute',
          style: { base: { top: 0, right: 0, width: 120 } },
          props: { src: 'https://images.example.com/x.png', alt: 'A "quoted" <alt> & more' },
        },
      ],
    },
    {
      op: 'setProps',
      id: 'n_herobody01',
      patch: { text: 'Tags <b>like this</b> & entities stay text' },
    },
  ]).doc;
}

/** Parse and re-serialize with attributes sorted (React sets <img src> last; order isn't semantic). */
const normalize = (html: string) => {
  const t = document.createElement('template');
  t.innerHTML = html;
  for (const el of t.content.querySelectorAll('*')) {
    const attrs = [...el.attributes]
      .map((a) => [a.name, a.value] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [name] of attrs) el.removeAttribute(name);
    for (const [name, value] of attrs) el.setAttribute(name, value);
  }
  return t.innerHTML;
};
const rules = (css: string) =>
  css
    .split(/\n|(?<=\})(?=\.|@)/)
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();

describe('DOM ↔ static parity', () => {
  it.each([
    ['annotated (canvas)', { annotate: true, showHidden: false }],
    ['clean (export)', { annotate: false, showHidden: false }],
  ])('markup and rules match: %s', async (_label, options) => {
    const doc = richDoc();
    const { container } = render(
      <FrameView doc={doc} ds={ds} frameId="f_desktop001" shadow={false} options={options} />,
    );
    await act(async () => {});
    const domFrame = container.querySelector('.cd-frame')!;
    const staticFrame = renderFrameStatic(doc, ds, 'f_desktop001', options);

    expect(normalize(domFrame.outerHTML)).toBe(normalize(staticFrame.html));

    const styles = [...container.querySelectorAll('style')];
    const domNodeCss = styles[2]!.textContent ?? '';
    expect(rules(domNodeCss)).toEqual(rules(staticFrame.css));
    expect(styles[1]!.textContent).toBe(staticFrame.frameCss);
  });

  it('escapes text and attributes in static output', () => {
    const { html } = renderFrameStatic(richDoc(), ds, 'f_desktop001', { annotate: false });
    expect(html).toContain('Tags &lt;b&gt;like this&lt;/b&gt; &amp; entities stay text');
    expect(html).toContain('alt="A &quot;quoted&quot; &lt;alt&gt; &amp; more"');
    expect(html).not.toContain('<b>');
  });
});

describe('renderDocumentHtml', () => {
  it('produces a standalone page without canvas annotations', () => {
    const { html, warnings } = renderDocumentHtml(richDoc(), ds, { title: 'Landing <test>' });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Landing &lt;test&gt;</title>');
    expect(html).not.toContain('data-cd-id');
    expect(html).toContain('.cd-frame[data-frame="f_desktop001"]{width:100%;}');
    expect(html).toContain('--color-primary:#4f46e5;');
    expect(html).toContain(
      '<svg class="cd-n_icon000001" aria-label="Menu" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path',
    );
    expect(warnings).toEqual([]);
  });

  it('is deterministic', () => {
    expect(renderDocumentHtml(richDoc(), ds).html).toBe(renderDocumentHtml(richDoc(), ds).html);
  });
});
