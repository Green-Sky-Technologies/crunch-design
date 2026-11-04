import { describe, expect, it } from 'vitest';
import { applyOps, emptyDoc, parseDoc, starterDesignSystem, type Node } from '@crunch/doc-model';
import {
  checkImportLimits,
  collectImageRefs,
  collectSvgCandidates,
  collectVariableIds,
  figmaNode,
  type FigmaNode,
} from './figma-node';
import { figmaToDoc, importOps } from './from-figma';
import { parseFontStyle, pluginNodeToRest } from './serialize';

const ds = starterDesignSystem();
let seq = 0;
const ids = (p: 'n' | 'f') => `${p}_t${String(++seq).padStart(6, '0')}`;

/** Hand-written REST payload (GET /v1/files/:key/nodes), following the documented node shapes. */
const card: FigmaNode = {
  id: '10:1',
  name: 'Pricing card',
  type: 'FRAME',
  absoluteBoundingBox: { x: 100, y: 200, width: 360, height: 480 },
  layoutMode: 'VERTICAL',
  primaryAxisSizingMode: 'AUTO',
  counterAxisSizingMode: 'FIXED',
  primaryAxisAlignItems: 'MIN',
  counterAxisAlignItems: 'MIN',
  itemSpacing: 16,
  paddingLeft: 24,
  paddingRight: 24,
  paddingTop: 24,
  paddingBottom: 24,
  cornerRadius: 16,
  clipsContent: true,
  fills: [
    {
      type: 'SOLID',
      color: { r: 1, g: 1, b: 1, a: 1 },
      boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:1' } },
    },
  ],
  strokes: [{ type: 'SOLID', color: { r: 0.894, g: 0.894, b: 0.906, a: 1 } }],
  strokeWeight: 1,
  strokeAlign: 'INSIDE',
  effects: [
    {
      type: 'DROP_SHADOW',
      visible: true,
      radius: 12,
      color: { r: 0, g: 0, b: 0, a: 0.08 },
      offset: { x: 0, y: 4 },
      spread: 0,
    },
  ],
  boundVariables: { itemSpacing: { type: 'VARIABLE_ALIAS', id: 'VariableID:2:1' } },
  children: [
    {
      id: '10:2',
      name: 'Title',
      type: 'TEXT',
      characters: 'Pro plan',
      absoluteBoundingBox: { x: 124, y: 224, width: 312, height: 32 },
      layoutSizingHorizontal: 'FILL',
      layoutSizingVertical: 'HUG',
      style: {
        fontFamily: 'Inter',
        fontWeight: 700,
        fontSize: 24,
        textAlignHorizontal: 'LEFT',
        lineHeightUnit: 'PIXELS',
        lineHeightPx: 32,
        letterSpacing: 0,
        textAutoResize: 'HEIGHT',
      },
      fills: [{ type: 'SOLID', color: { r: 0.0941, g: 0.0941, b: 0.1059, a: 1 } }],
    },
    {
      id: '10:3',
      name: 'Row',
      type: 'FRAME',
      absoluteBoundingBox: { x: 124, y: 272, width: 312, height: 40 },
      layoutMode: 'HORIZONTAL',
      layoutSizingHorizontal: 'FILL',
      layoutSizingVertical: 'HUG',
      primaryAxisAlignItems: 'SPACE_BETWEEN',
      counterAxisAlignItems: 'CENTER',
      itemSpacing: 8,
      children: [
        {
          id: '10:4',
          name: 'Icon',
          type: 'VECTOR',
          absoluteBoundingBox: { x: 124, y: 280, width: 24, height: 24 },
          fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
        },
        {
          id: '10:5',
          name: 'Button',
          type: 'INSTANCE',
          componentId: '1:9',
          absoluteBoundingBox: { x: 340, y: 272, width: 96, height: 40 },
          layoutMode: 'HORIZONTAL',
          layoutSizingHorizontal: 'HUG',
          layoutSizingVertical: 'HUG',
          paddingLeft: 16,
          paddingRight: 16,
          paddingTop: 8,
          paddingBottom: 8,
          cornerRadius: 8,
          fills: [{ type: 'SOLID', color: { r: 0.3098, g: 0.2745, b: 0.898, a: 1 } }],
          children: [
            {
              id: '10:6',
              name: 'Label',
              type: 'TEXT',
              characters: 'Buy',
              style: {
                fontFamily: 'Inter',
                fontWeight: 600,
                fontSize: 14,
                textAutoResize: 'WIDTH_AND_HEIGHT',
              },
              fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
            },
          ],
        },
      ],
    },
    {
      id: '10:7',
      name: 'Hero image',
      type: 'RECTANGLE',
      absoluteBoundingBox: { x: 124, y: 328, width: 312, height: 120 },
      layoutSizingHorizontal: 'FILL',
      layoutSizingVertical: 'FIXED',
      cornerRadius: 8,
      fills: [{ type: 'IMAGE', scaleMode: 'FILL', imageRef: 'abc123' }],
    },
    {
      id: '10:8',
      name: 'Badge',
      type: 'FRAME',
      layoutPositioning: 'ABSOLUTE',
      absoluteBoundingBox: { x: 380, y: 210, width: 70, height: 24 },
      layoutMode: 'NONE',
      fills: [
        {
          type: 'GRADIENT_LINEAR',
          gradientHandlePositions: [
            { x: 0, y: 0.5 },
            { x: 1, y: 0.5 },
            { x: 0, y: 1 },
          ],
          gradientStops: [
            { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
            { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
          ],
        },
      ],
      children: [],
    },
  ],
};

const svgs = {
  '10:4':
    '<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h24v24H0z" fill="#000"/></svg>',
};
const images = { abc123: 'https://s3-alpha-sig.figma.com/img/abc/123' };
const variables = { 'VariableID:1:1': 'color/surface', 'VariableID:2:1': 'space/4' };

function byName(nodes: Node[], name: string): Node {
  const n = nodes.find((x) => x.name === name);
  if (!n) throw new Error(`no node ${name}`);
  return n;
}

describe('figmaToDoc (REST fixture)', () => {
  const parsed = figmaNode.parse(card);
  const result = figmaToDoc([parsed], {
    svgs,
    images,
    variables,
    designSystem: ds,
    origin: { x: 2000, y: 0 },
    newId: ids,
  });
  const { frame, nodes } = result.frames[0]!;

  it('produces a valid document through insertFrame ops', () => {
    const { doc } = applyOps(emptyDoc(), importOps(result, 0));
    expect(() => parseDoc(doc)).not.toThrow();
    expect(frame).toMatchObject({
      name: 'Pricing card',
      width: 360,
      height: 'auto',
      canvas: { x: 2000, y: 0 },
    });
    expect(result.stats).toMatchObject({ svgs: 1, images: 1 });
  });

  it('maps auto-layout to flow with token-bound values', () => {
    const root = nodes[0]!;
    expect(root.style.base).toMatchObject({
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: { token: 'space.4' }, // bound variable -> token
      paddingTop: { token: 'space.6' }, // 24px matched by value
      borderRadius: { token: 'radius.lg' }, // 16px == 1rem matched by value
      backgroundColor: { token: 'color.surface' },
      borderStyle: 'solid',
      borderColor: { token: 'color.border' },
      overflow: 'hidden',
      boxShadow: '0px 4px 12px 0px #00000014',
      width: 'fill',
    });
    const row = byName(nodes, 'Row');
    expect(row.style.base).toMatchObject({
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      width: 'fill',
      height: 'hug',
    });
    expect(row.style.base?.gap).toBeUndefined(); // SPACE_BETWEEN ignores spacing
  });

  it('maps text styles to validated StyleProps', () => {
    const title = byName(nodes, 'Title');
    expect(title).toMatchObject({ type: 'text', tag: 'h2', props: { text: 'Pro plan' } });
    expect(title.style.base).toMatchObject({
      fontFamily: 'Inter',
      fontWeight: 700,
      fontSize: { token: 'text.2xl' },
      lineHeight: '32px',
      width: 'fill',
      color: { token: 'color.text' },
    });
    const label = byName(nodes, 'Label');
    expect(label.style.base).toMatchObject({
      whiteSpace: 'nowrap',
      color: { token: 'color.background' },
    });
  });

  it('imports vectors as svg nodes, image fills as image nodes, and absolute children', () => {
    expect(byName(nodes, 'Icon')).toMatchObject({ type: 'svg', props: { svg: svgs['10:4'] } });
    expect(byName(nodes, 'Hero image')).toMatchObject({
      type: 'image',
      props: { src: images.abc123 },
      style: { base: { objectFit: 'cover', height: 120, width: 'fill' } },
    });
    const badge = byName(nodes, 'Badge');
    expect(badge.positioning).toBe('absolute');
    expect(badge.style.base).toMatchObject({
      left: 280,
      top: 10,
      width: 70,
      height: 24,
      backgroundImage: 'linear-gradient(90deg, #ff0000 0%, #0000ff 100%)',
    });
    expect(byName(nodes, 'Button').style.base).toMatchObject({
      backgroundColor: { token: 'color.primary' },
      width: 'hug',
    });
  });

  it('reports what was lost', () => {
    const msgs = result.report.map((r) => r.message);
    expect(msgs).toContain('Components and instances are imported as plain layers');
    expect(msgs.some((m) => /matched design-system tokens/.test(m))).toBe(true);
  });

  it('collects what the caller must fetch', () => {
    expect(collectSvgCandidates([parsed])).toEqual(['10:4']);
    expect(collectImageRefs([parsed])).toEqual(['abc123']);
    expect(collectVariableIds([parsed]).sort()).toEqual(['VariableID:1:1', 'VariableID:2:1']);
  });
});

describe('figmaToDoc safety and limits', () => {
  it('replaces unsafe SVG and images with boxes and reports it', () => {
    const r = figmaToDoc([figmaNode.parse(card)], {
      svgs: { '10:4': '<svg onload="alert(1)"><script>x</script></svg>' },
      images: { abc123: 'http://insecure.example/x.png' },
      newId: ids,
    });
    const nodes = r.frames[0]!.nodes;
    expect(byName(nodes, 'Icon').type).toBe('box');
    expect(byName(nodes, 'Hero image').type).toBe('box');
    expect(JSON.stringify(nodes)).not.toContain('alert');
    expect(r.report.map((x) => x.message)).toEqual(
      expect.arrayContaining([
        'Vector SVG failed validation; replaced by an empty box',
        'Image could not be resolved to a safe URL; replaced by a box',
      ]),
    );
    const { doc } = applyOps(emptyDoc(), importOps(r, 0));
    expect(() => parseDoc(doc)).not.toThrow();
  });

  it('drops invalid style values instead of failing', () => {
    const r = figmaToDoc(
      [
        {
          id: '1:1',
          name: 'X',
          type: 'FRAME',
          absoluteBoundingBox: { x: 0, y: 0, width: 50, height: 50 },
          children: [
            {
              id: '1:2',
              name: 'T',
              type: 'TEXT',
              characters: 'hi',
              style: { fontFamily: 'Bad;Font{}', fontSize: 12 },
            },
          ],
        },
      ],
      { newId: ids },
    );
    expect(r.frames[0]!.frame.width).toBe(160); // clamped
    expect(r.report.some((x) => x.subject === 'fontFamily')).toBe(true);
    const { doc } = applyOps(emptyDoc(), importOps(r, 0));
    expect(() => parseDoc(doc)).not.toThrow();
  });

  it('enforces node and depth limits', () => {
    let deep: FigmaNode = { id: '1:0', name: 'leaf', type: 'FRAME' };
    for (let i = 1; i < 80; i++)
      deep = { id: `1:${i}`, name: 'g', type: 'FRAME', children: [deep] };
    expect(() => checkImportLimits([deep])).toThrow(/deeper/);
    const wide: FigmaNode = {
      id: '2:0',
      name: 'w',
      type: 'FRAME',
      children: Array.from({ length: 5001 }, (_, i) => ({
        id: `3:${i}`,
        name: 'x',
        type: 'RECTANGLE',
      })),
    };
    expect(() => checkImportLimits([wide])).toThrow(/limited/);
  });
});

describe('pluginNodeToRest', () => {
  const MIXED = Symbol('mixed');
  const pluginFrame = {
    id: '5:1',
    name: 'Card',
    type: 'FRAME',
    visible: true,
    absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 200 },
    layoutMode: 'VERTICAL',
    layoutSizingHorizontal: 'FIXED',
    layoutSizingVertical: 'HUG',
    itemSpacing: 12,
    paddingTop: 16,
    paddingRight: 16,
    paddingBottom: 16,
    paddingLeft: 16,
    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1, visible: true }],
    strokes: [],
    strokeWeight: MIXED,
    strokeTopWeight: 0,
    strokeRightWeight: 0,
    strokeBottomWeight: 2,
    strokeLeftWeight: 0,
    cornerRadius: MIXED,
    topLeftRadius: 8,
    topRightRadius: 8,
    bottomRightRadius: 0,
    bottomLeftRadius: 0,
    effects: [],
    clipsContent: false,
    children: [
      {
        id: '5:2',
        name: 'Hello',
        type: 'TEXT',
        characters: 'Hello',
        fontName: MIXED,
        getRangeFontName: () => ({ family: 'Inter', style: 'Semi Bold Italic' }),
        fontSize: 18,
        lineHeight: { unit: 'PERCENT', value: 150 },
        letterSpacing: { unit: 'PERCENT', value: 10 },
        textCase: 'UPPER',
        textDecoration: 'NONE',
        textAlignHorizontal: 'CENTER',
        textAutoResize: 'HEIGHT',
        layoutSizingHorizontal: 'FILL',
        layoutSizingVertical: 'HUG',
        fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0.5 }],
      },
    ],
  };

  it('serializes plugin nodes into the REST shape the importer reads', () => {
    const rest = pluginNodeToRest(pluginFrame, MIXED);
    expect(figmaNode.safeParse(rest).success).toBe(true);
    expect(rest.rectangleCornerRadii).toEqual([8, 8, 0, 0]);
    expect(rest.individualStrokeWeights).toEqual({ top: 0, right: 0, bottom: 2, left: 0 });
    const text = rest.children![0]!;
    expect(text.style).toMatchObject({
      fontFamily: 'Inter',
      fontWeight: 600,
      italic: true,
      fontSize: 18,
      lineHeightUnit: 'FONT_SIZE_%',
      lineHeightPercentFontSize: 150,
      letterSpacing: 1.8,
      textCase: 'UPPER',
    });
    expect(text.styleOverrideTable).toEqual({ mixed: true });

    const r = figmaToDoc([rest], { newId: ids });
    const t = r.frames[0]!.nodes.find((n) => n.type === 'text')!;
    expect(t.style.base).toMatchObject({
      fontStyle: 'italic',
      lineHeight: 1.5,
      textTransform: 'uppercase',
      textAlign: 'center',
      color: '#00000080',
    });
    expect(r.report.some((x) => /flattened/.test(x.message))).toBe(true);
    expect(r.frames[0]!.frame.height).toBe('auto');
  });

  it('parses font style names', () => {
    expect(parseFontStyle('Regular')).toEqual({ weight: 400, italic: false });
    expect(parseFontStyle('Extra Bold Italic')).toEqual({ weight: 800, italic: true });
    expect(parseFontStyle('SemiBold')).toEqual({ weight: 600, italic: false });
  });

  it('caps the number of serialized layers', () => {
    expect(() => pluginNodeToRest(pluginFrame, MIXED, { maxNodes: 1, count: 0 })).toThrow(
      /more than 1/,
    );
  });
});
