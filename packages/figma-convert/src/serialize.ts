/**
 * Plugin SceneNode -> REST-shaped FigmaNode (Story 8.3, "send it from the plugin").
 * Dependency-free (bundled by the plugin). Reads plugin nodes structurally, so it's testable with
 * plain objects; `mixed` is `figma.mixed` (a symbol) in the plugin.
 */
import type { FigmaNode, FigmaPaint } from './figma-node';

type Obj = Record<string, unknown>;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const WEIGHTS: Record<string, number> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  regular: 400,
  normal: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
};

/** Font style name ("Semi Bold Italic") -> weight and italic. */
export function parseFontStyle(style: string): { weight: number; italic: boolean } {
  const s = style.toLowerCase();
  const italic = /italic|oblique/.test(s);
  const key = s.replace(/italic|oblique/g, '').replace(/[\s-]/g, '');
  return { weight: WEIGHTS[key] ?? 400, italic };
}

/** Invert a 2x3 affine transform. */
function invert(t: number[][]): number[][] | null {
  const [a, b, c] = t[0]!;
  const [d, e, f] = t[1]!;
  const det = a! * e! - b! * d!;
  if (Math.abs(det) < 1e-9) return null;
  return [
    [e! / det, -b! / det, (b! * f! - c! * e!) / det],
    [-d! / det, a! / det, (c! * d! - a! * f!) / det],
  ];
}

function paint(p: Obj): FigmaPaint | null {
  const type = str(p.type);
  if (!type) return null;
  const out: FigmaPaint = { type };
  if (typeof p.visible === 'boolean') out.visible = p.visible;
  if (isNum(p.opacity)) out.opacity = p.opacity;
  const c = p.color as Obj | undefined;
  if (c && isNum(c.r)) out.color = { r: c.r as number, g: c.g as number, b: c.b as number, a: 1 };
  if (Array.isArray(p.gradientStops)) {
    out.gradientStops = (p.gradientStops as Obj[]).slice(0, 32).map((s) => {
      const sc = s.color as Obj;
      return {
        position: s.position as number,
        color: {
          r: sc.r as number,
          g: sc.g as number,
          b: sc.b as number,
          a: (sc.a as number) ?? 1,
        },
      };
    });
  }
  if (Array.isArray(p.gradientTransform)) {
    // Handles are the gradient-space points (0, .5) and (1, .5) mapped back to node space.
    const inv = invert(p.gradientTransform as number[][]);
    if (inv) {
      const apply = (x: number, y: number) => ({
        x: inv[0]![0]! * x + inv[0]![1]! * y + inv[0]![2]!,
        y: inv[1]![0]! * x + inv[1]![1]! * y + inv[1]![2]!,
      });
      out.gradientHandlePositions = [apply(0, 0.5), apply(1, 0.5)];
    }
  }
  if (type === 'IMAGE') {
    out.imageRef = str(p.imageHash) ?? null;
    out.scaleMode = str(p.scaleMode);
  }
  if (p.boundVariables && typeof p.boundVariables === 'object')
    out.boundVariables = p.boundVariables as FigmaPaint['boundVariables'];
  return out;
}

function paints(v: unknown): FigmaPaint[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return (v as Obj[]).map(paint).filter((p): p is FigmaPaint => p !== null);
}

const COPY_STRING = [
  'layoutMode',
  'layoutWrap',
  'primaryAxisAlignItems',
  'counterAxisAlignItems',
  'primaryAxisSizingMode',
  'counterAxisSizingMode',
  'layoutSizingHorizontal',
  'layoutSizingVertical',
  'layoutPositioning',
  'layoutAlign',
  'strokeAlign',
] as const;
const COPY_NUMBER = [
  'opacity',
  'itemSpacing',
  'counterAxisSpacing',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'paddingBottom',
  'layoutGrow',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
] as const;

export interface SerializeLimits {
  maxNodes: number;
  count: number;
}

/** Serialize a plugin node tree. Throws when it exceeds `limits.maxNodes`. */
export function pluginNodeToRest(
  node: unknown,
  mixed: symbol,
  limits: SerializeLimits = { maxNodes: 5000, count: 0 },
): FigmaNode {
  const n = node as Obj;
  if (++limits.count > limits.maxNodes)
    throw new Error(`Selection has more than ${limits.maxNodes} layers`);
  const out: FigmaNode = { id: String(n.id), name: String(n.name ?? ''), type: String(n.type) };
  if (n.visible === false) out.visible = false;
  for (const k of COPY_STRING) {
    const v = str(n[k]);
    if (v) (out as unknown as Obj)[k] = v;
  }
  for (const k of COPY_NUMBER) if (isNum(n[k])) (out as unknown as Obj)[k] = n[k];
  // The plugin API reports degrees; the REST shape (and the importer) uses radians.
  if (isNum(n.rotation) && n.rotation !== 0) out.rotation = (n.rotation * Math.PI) / 180;
  const bb = n.absoluteBoundingBox as Obj | null | undefined;
  if (bb && isNum(bb.width))
    out.absoluteBoundingBox = {
      x: bb.x as number,
      y: bb.y as number,
      width: bb.width as number,
      height: bb.height as number,
    };

  const fills = n.fills === mixed ? undefined : paints(n.fills);
  if (fills) out.fills = fills;
  const strokes = paints(n.strokes);
  if (strokes) out.strokes = strokes;
  if (isNum(n.strokeWeight)) out.strokeWeight = n.strokeWeight;
  else if (n.strokeWeight === mixed && isNum(n.strokeTopWeight)) {
    out.individualStrokeWeights = {
      top: n.strokeTopWeight as number,
      right: n.strokeRightWeight as number,
      bottom: n.strokeBottomWeight as number,
      left: n.strokeLeftWeight as number,
    };
  }
  if (Array.isArray(n.dashPattern) && n.dashPattern.length)
    out.strokeDashes = n.dashPattern as number[];
  if (isNum(n.cornerRadius)) out.cornerRadius = n.cornerRadius;
  else if (n.cornerRadius === mixed && isNum(n.topLeftRadius)) {
    out.rectangleCornerRadii = [
      n.topLeftRadius as number,
      n.topRightRadius as number,
      n.bottomRightRadius as number,
      n.bottomLeftRadius as number,
    ];
  }
  if (Array.isArray(n.effects)) {
    out.effects = (n.effects as Obj[]).map((e) => ({
      type: String(e.type),
      visible: e.visible !== false,
      ...(isNum(e.radius) ? { radius: e.radius } : {}),
      ...(e.color ? { color: e.color as { r: number; g: number; b: number; a: number } } : {}),
      ...(e.offset ? { offset: e.offset as { x: number; y: number } } : {}),
      ...(isNum(e.spread) ? { spread: e.spread } : {}),
    }));
  }
  if (typeof n.clipsContent === 'boolean') out.clipsContent = n.clipsContent;
  if (n.boundVariables && typeof n.boundVariables === 'object') {
    out.boundVariables = n.boundVariables as FigmaNode['boundVariables'];
  }

  if (out.type === 'TEXT') {
    out.characters = String(n.characters ?? '');
    let isMixed = false;
    const first = <T>(prop: string, getter: string): T | undefined => {
      const v = n[prop];
      if (v !== mixed) return v as T;
      isMixed = true;
      const fn = n[getter];
      return typeof fn === 'function' && out.characters
        ? (fn as (s: number, e: number) => T).call(n, 0, 1)
        : undefined;
    };
    const fontName = first<{ family: string; style: string }>('fontName', 'getRangeFontName');
    const fontSize = first<number>('fontSize', 'getRangeFontSize');
    const lineHeight = first<{ unit: string; value?: number }>('lineHeight', 'getRangeLineHeight');
    const letterSpacing = first<{ unit: string; value: number }>(
      'letterSpacing',
      'getRangeLetterSpacing',
    );
    const textCase = first<string>('textCase', 'getRangeTextCase');
    const textDecoration = first<string>('textDecoration', 'getRangeTextDecoration');
    if (n.fills === mixed) {
      isMixed = true;
      const fn = n.getRangeFills;
      if (typeof fn === 'function' && out.characters)
        out.fills = paints((fn as (s: number, e: number) => unknown).call(n, 0, 1));
    }
    const fs = fontName ? parseFontStyle(fontName.style) : null;
    const size = isNum(fontSize) ? fontSize : 16;
    out.style = {
      ...(fontName
        ? { fontFamily: fontName.family, fontWeight: fs!.weight, italic: fs!.italic }
        : {}),
      fontSize: size,
      ...(textCase ? { textCase } : {}),
      ...(textDecoration ? { textDecoration } : {}),
      ...(str(n.textAlignHorizontal)
        ? { textAlignHorizontal: n.textAlignHorizontal as string }
        : {}),
      ...(str(n.textAutoResize) ? { textAutoResize: n.textAutoResize as string } : {}),
    };
    if (letterSpacing && letterSpacing.value) {
      out.style.letterSpacing =
        letterSpacing.unit === 'PERCENT' ? (letterSpacing.value / 100) * size : letterSpacing.value;
    }
    if (lineHeight?.unit === 'PIXELS' && isNum(lineHeight.value)) {
      out.style.lineHeightUnit = 'PIXELS';
      out.style.lineHeightPx = lineHeight.value;
    } else if (lineHeight?.unit === 'PERCENT' && isNum(lineHeight.value)) {
      out.style.lineHeightUnit = 'FONT_SIZE_%';
      out.style.lineHeightPercentFontSize = lineHeight.value;
    }
    if (isMixed) out.styleOverrideTable = { mixed: true };
  }

  if (Array.isArray(n.children) && out.type !== 'BOOLEAN_OPERATION') {
    out.children = (n.children as unknown[]).map((c) => pluginNodeToRest(c, mixed, limits));
  }
  return out;
}
