/**
 * Allowlist SVG sanitizer. Rebuilds markup from parsed tokens: only allowlisted elements and
 * attributes survive, and attribute values are re-escaped. Runs on top of the doc-model
 * `svgMarkup` check (defense in depth; SPEC 9.3). Works without a DOM, so the server can use it too.
 */

const ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'circle',
  'ellipse',
  'rect',
  'line',
  'polyline',
  'polygon',
  'defs',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'mask',
  'title',
  'desc',
  'text',
  'tspan',
  'use',
  'symbol',
]);

/** Elements whose contents are dropped entirely. */
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'foreignobject',
  'iframe',
  'object',
  'embed',
]);

const ATTRS = new Set([
  'xmlns',
  'viewbox',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'transform',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-miterlimit',
  'opacity',
  'clip-rule',
  'clip-path',
  'mask',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientunits',
  'gradienttransform',
  'spreadmethod',
  'preserveaspectratio',
  'id',
  'href',
  'xlink:href',
  'font-size',
  'font-family',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'role',
  'aria-hidden',
  'aria-label',
  'focusable',
  'vector-effect',
]);

/** SVG attributes are case-sensitive in the DOM; restore canonical casing. */
const CANONICAL: Record<string, string> = {
  viewbox: 'viewBox',
  preserveaspectratio: 'preserveAspectRatio',
  gradientunits: 'gradientUnits',
  gradienttransform: 'gradientTransform',
  spreadmethod: 'spreadMethod',
};

const escAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function safeAttr(name: string, value: string): boolean {
  const v = value.trim().toLowerCase();
  if (/javascript:|data:|vbscript:|expression\(/.test(v)) return false;
  if (name === 'href' || name === 'xlink:href') return /^#[\w-]+$/.test(value.trim());
  if (/url\(/.test(v)) return /^url\(\s*#[\w-]+\s*\)$/.test(v);
  return true;
}

const TAG_RE =
  /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
const ATTR_RE = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

export function sanitizeSvg(input: string): string {
  // Drop comments, doctypes, CDATA and processing instructions up front.
  const src = input.replace(
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>/g,
    '',
  );
  let out = '';
  let last = 0;
  let dropDepth = 0;
  const stack: string[] = [];
  for (const m of src.matchAll(TAG_RE)) {
    const [whole, closing, rawName, rawAttrs, selfClose] = m;
    const name = rawName!.toLowerCase();
    const text = src.slice(last, m.index);
    last = m.index! + whole.length;
    if (!dropDepth && text.trim()) out += escText(text);

    if (DROP_WITH_CONTENT.has(name)) {
      if (!selfClose) dropDepth += closing ? -1 : 1;
      if (dropDepth < 0) dropDepth = 0;
      continue;
    }
    if (dropDepth || !ELEMENTS.has(name)) continue;

    if (closing) {
      const idx = stack.map((t) => t.toLowerCase()).lastIndexOf(name);
      if (idx >= 0) {
        while (stack.length > idx) out += `</${stack.pop()}>`;
      }
      continue;
    }
    let attrs = '';
    for (const a of (rawAttrs ?? '').matchAll(ATTR_RE)) {
      const an = a[1]!.toLowerCase();
      const av = a[2] ?? a[3] ?? a[4] ?? '';
      if (!ATTRS.has(an) || !safeAttr(an, av)) continue;
      attrs += ` ${CANONICAL[an] ?? an}="${escAttr(av)}"`;
    }
    const tag =
      name === 'lineargradient'
        ? 'linearGradient'
        : name === 'radialgradient'
          ? 'radialGradient'
          : name === 'clippath'
            ? 'clipPath'
            : name;
    if (selfClose) out += `<${tag}${attrs}/>`;
    else {
      out += `<${tag}${attrs}>`;
      stack.push(tag);
    }
  }
  const tail = src.slice(last);
  if (!dropDepth && tail.trim()) out += escText(tail);
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}
