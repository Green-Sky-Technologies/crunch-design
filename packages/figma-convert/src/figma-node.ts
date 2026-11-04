/**
 * The subset of Figma's REST node JSON that import understands (Story 8.3). The plugin serializes
 * its nodes into the same shape (serialize.ts), so one converter handles both sources.
 * Unknown fields are stripped; known fields are type-checked. Size limits are enforced here.
 */
import { z } from 'zod';

export const MAX_IMPORT_NODES = 5000;
export const MAX_IMPORT_DEPTH = 64;

const num = z.number().finite();
const color = z.object({ r: num, g: num, b: num, a: num.optional() });
const alias = z.object({ type: z.literal('VARIABLE_ALIAS'), id: z.string().max(200) });
const bound = z.record(z.string().max(64), z.union([alias, z.array(alias).max(50)])).optional();

export const figmaPaint = z.object({
  type: z.string().max(40),
  visible: z.boolean().optional(),
  opacity: num.optional(),
  color: color.optional(),
  gradientHandlePositions: z
    .array(z.object({ x: num, y: num }))
    .max(3)
    .optional(),
  gradientStops: z
    .array(z.object({ position: num, color }))
    .max(32)
    .optional(),
  scaleMode: z.string().max(20).optional(),
  imageRef: z.string().max(200).nullable().optional(),
  boundVariables: bound,
});
export type FigmaPaint = z.infer<typeof figmaPaint>;

export const figmaEffect = z.object({
  type: z.string().max(40),
  visible: z.boolean().optional(),
  radius: num.optional(),
  color: color.optional(),
  offset: z.object({ x: num, y: num }).optional(),
  spread: num.optional(),
});

export const typeStyle = z.object({
  fontFamily: z.string().max(200).optional(),
  fontPostScriptName: z.string().max(200).nullable().optional(),
  italic: z.boolean().optional(),
  fontWeight: num.optional(),
  fontSize: num.optional(),
  textCase: z.string().max(40).optional(),
  textDecoration: z.string().max(40).optional(),
  textAlignHorizontal: z.string().max(20).optional(),
  letterSpacing: num.optional(),
  lineHeightPx: num.optional(),
  lineHeightPercentFontSize: num.optional(),
  lineHeightUnit: z.string().max(20).optional(),
  textAutoResize: z.string().max(40).optional(),
});

const rect = z.object({ x: num, y: num, width: num, height: num });

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  opacity?: number;
  /** Radians, counter-clockwise (REST convention; the plugin serializer converts from degrees). */
  rotation?: number;
  children?: FigmaNode[];
  absoluteBoundingBox?: z.infer<typeof rect> | null;
  layoutMode?: string;
  layoutWrap?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  primaryAxisSizingMode?: string;
  counterAxisSizingMode?: string;
  itemSpacing?: number;
  counterAxisSpacing?: number | null;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  layoutPositioning?: string;
  layoutAlign?: string;
  layoutGrow?: number;
  minWidth?: number | null;
  maxWidth?: number | null;
  minHeight?: number | null;
  maxHeight?: number | null;
  fills?: FigmaPaint[];
  strokes?: FigmaPaint[];
  strokeWeight?: number;
  individualStrokeWeights?: { top: number; right: number; bottom: number; left: number };
  strokeAlign?: string;
  strokeDashes?: number[];
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  effects?: z.infer<typeof figmaEffect>[];
  clipsContent?: boolean;
  characters?: string;
  style?: z.infer<typeof typeStyle>;
  styleOverrideTable?: Record<string, unknown>;
  boundVariables?: Record<
    string,
    { type: 'VARIABLE_ALIAS'; id: string } | { type: 'VARIABLE_ALIAS'; id: string }[]
  >;
  componentId?: string;
}

export const figmaNode: z.ZodType<FigmaNode> = z.lazy(() =>
  z.object({
    id: z.string().min(1).max(200),
    name: z.string().max(1000),
    type: z.string().max(40),
    visible: z.boolean().optional(),
    opacity: num.optional(),
    rotation: num.optional(),
    children: z.array(figmaNode).max(MAX_IMPORT_NODES).optional(),
    absoluteBoundingBox: rect.nullable().optional(),
    layoutMode: z.string().max(20).optional(),
    layoutWrap: z.string().max(20).optional(),
    primaryAxisAlignItems: z.string().max(20).optional(),
    counterAxisAlignItems: z.string().max(20).optional(),
    primaryAxisSizingMode: z.string().max(20).optional(),
    counterAxisSizingMode: z.string().max(20).optional(),
    itemSpacing: num.optional(),
    counterAxisSpacing: num.nullable().optional(),
    paddingLeft: num.optional(),
    paddingRight: num.optional(),
    paddingTop: num.optional(),
    paddingBottom: num.optional(),
    layoutSizingHorizontal: z.string().max(20).optional(),
    layoutSizingVertical: z.string().max(20).optional(),
    layoutPositioning: z.string().max(20).optional(),
    layoutAlign: z.string().max(20).optional(),
    layoutGrow: num.optional(),
    minWidth: num.nullable().optional(),
    maxWidth: num.nullable().optional(),
    minHeight: num.nullable().optional(),
    maxHeight: num.nullable().optional(),
    fills: z.array(figmaPaint).max(32).optional(),
    strokes: z.array(figmaPaint).max(32).optional(),
    strokeWeight: num.optional(),
    individualStrokeWeights: z.object({ top: num, right: num, bottom: num, left: num }).optional(),
    strokeAlign: z.string().max(20).optional(),
    strokeDashes: z.array(num).max(16).optional(),
    cornerRadius: num.optional(),
    rectangleCornerRadii: z.array(num).length(4).optional(),
    effects: z.array(figmaEffect).max(32).optional(),
    clipsContent: z.boolean().optional(),
    characters: z.string().max(20_000).optional(),
    style: typeStyle.optional(),
    styleOverrideTable: z.record(z.string(), z.unknown()).optional(),
    boundVariables: bound,
    componentId: z.string().max(200).optional(),
  }),
) as z.ZodType<FigmaNode>;

/** Count nodes and depth; throws on limits. */
export function checkImportLimits(roots: FigmaNode[]): number {
  let count = 0;
  const visit = (n: FigmaNode, depth: number) => {
    if (depth > MAX_IMPORT_DEPTH) throw new Error(`Figma tree is deeper than ${MAX_IMPORT_DEPTH}`);
    if (++count > MAX_IMPORT_NODES)
      throw new Error(`Import is limited to ${MAX_IMPORT_NODES} nodes`);
    for (const c of n.children ?? []) visit(c, depth + 1);
  };
  for (const r of roots) visit(r, 0);
  return count;
}

const VECTOR_TYPES = new Set([
  'VECTOR',
  'BOOLEAN_OPERATION',
  'STAR',
  'LINE',
  'POLYGON',
  'REGULAR_POLYGON',
  'ELLIPSE',
]);

/** A node best imported as one SVG: a vector, or a small group/frame made only of vectors (an icon). */
export function isVectorish(n: FigmaNode): boolean {
  if (VECTOR_TYPES.has(n.type)) {
    // Plain circles/ellipses with a solid fill map fine to boxes; only export ones with strokes/gradients.
    if (n.type === 'ELLIPSE') return false;
    return true;
  }
  if ((n.type === 'GROUP' || n.type === 'FRAME' || n.type === 'INSTANCE') && n.children?.length) {
    const bb = n.absoluteBoundingBox;
    const small = !bb || (bb.width <= 128 && bb.height <= 128);
    return small && n.children.every((c) => VECTOR_TYPES.has(c.type) || isVectorish(c));
  }
  return false;
}

/** Figma node ids to export as SVG (vectors and icon groups), outermost only. */
export function collectSvgCandidates(roots: FigmaNode[], max = 300): string[] {
  const out: string[] = [];
  const visit = (n: FigmaNode, isRoot: boolean) => {
    if (out.length >= max) return;
    if (!isRoot && n.visible !== false && isVectorish(n)) {
      out.push(n.id);
      return;
    }
    for (const c of n.children ?? []) visit(c, false);
  };
  for (const r of roots) visit(r, true);
  return out;
}

/** Image fill refs used by image-like leaves. */
export function collectImageRefs(roots: FigmaNode[]): string[] {
  const refs = new Set<string>();
  const visit = (n: FigmaNode) => {
    for (const f of n.fills ?? [])
      if (f.type === 'IMAGE' && f.imageRef && f.visible !== false) refs.add(f.imageRef);
    for (const c of n.children ?? []) visit(c);
  };
  roots.forEach(visit);
  return [...refs];
}

/** Variable ids referenced by bound variables anywhere in the tree. */
export function collectVariableIds(roots: FigmaNode[]): string[] {
  const ids = new Set<string>();
  const add = (b: FigmaNode['boundVariables'] | FigmaPaint['boundVariables']) => {
    for (const v of Object.values(b ?? {}))
      for (const a of Array.isArray(v) ? v : [v]) ids.add(a.id);
  };
  const visit = (n: FigmaNode) => {
    add(n.boundVariables);
    for (const p of [...(n.fills ?? []), ...(n.strokes ?? [])]) add(p.boundVariables);
    for (const c of n.children ?? []) visit(c);
  };
  roots.forEach(visit);
  return [...ids];
}
