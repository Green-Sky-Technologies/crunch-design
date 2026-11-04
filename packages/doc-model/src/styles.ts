/**
 * The StyleProps allowlist. It's the single registry of what a node can be styled with,
 * used by validation, the renderer (CSS), the inspector (Story 3.3), the Tailwind mapping
 * (Story 7.3) and the Figma mapping (Epic 8). The set intentionally mirrors what Tailwind can express.
 *
 * Every prop accepts a literal (validated by its schema) or a token reference.
 */
import { z } from 'zod';
import * as v from './values';

export type StyleGroup =
  | 'layout'
  | 'flexChild'
  | 'grid'
  | 'size'
  | 'spacing'
  | 'position'
  | 'typography'
  | 'fill'
  | 'border'
  | 'effects';

/** Which token types make sense for a prop (inspector token picker, linter). */
export type TokenKind =
  | 'color'
  | 'dimension'
  | 'fontFamily'
  | 'fontWeight'
  | 'fontSize'
  | 'lineHeight'
  | 'shadow'
  | 'number'
  | 'radius';

interface PropDef {
  group: StyleGroup;
  css: string;
  schema: z.ZodType;
  tokens?: TokenKind[];
  /** Applies only to text nodes (inherited typography is still allowed on boxes). */
  label: string;
}

const e = <T extends readonly [string, ...string[]]>(vals: T) => z.enum(vals);
const spacing = (label: string, css: string): PropDef => ({
  group: 'spacing',
  css,
  schema: v.length,
  tokens: ['dimension'],
  label,
});

export const STYLE_PROPS = {
  // ---- layout (container) ----
  display: {
    group: 'layout',
    css: 'display',
    schema: e(['flex', 'grid', 'block', 'inline', 'inline-block', 'inline-flex', 'none']),
    label: 'Display',
  },
  flexDirection: {
    group: 'layout',
    css: 'flex-direction',
    schema: e(['row', 'column', 'row-reverse', 'column-reverse']),
    label: 'Direction',
  },
  flexWrap: {
    group: 'layout',
    css: 'flex-wrap',
    schema: e(['nowrap', 'wrap', 'wrap-reverse']),
    label: 'Wrap',
  },
  justifyContent: {
    group: 'layout',
    css: 'justify-content',
    schema: e([
      'flex-start',
      'center',
      'flex-end',
      'space-between',
      'space-around',
      'space-evenly',
      'stretch',
    ]),
    label: 'Justify',
  },
  alignItems: {
    group: 'layout',
    css: 'align-items',
    schema: e(['flex-start', 'center', 'flex-end', 'stretch', 'baseline']),
    label: 'Align',
  },
  alignContent: {
    group: 'layout',
    css: 'align-content',
    schema: e(['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'stretch']),
    label: 'Align content',
  },
  gap: { group: 'layout', css: 'gap', schema: v.length, tokens: ['dimension'], label: 'Gap' },
  rowGap: {
    group: 'layout',
    css: 'row-gap',
    schema: v.length,
    tokens: ['dimension'],
    label: 'Row gap',
  },
  columnGap: {
    group: 'layout',
    css: 'column-gap',
    schema: v.length,
    tokens: ['dimension'],
    label: 'Column gap',
  },
  overflow: {
    group: 'layout',
    css: 'overflow',
    schema: e(['visible', 'hidden', 'auto', 'scroll', 'clip']),
    label: 'Overflow',
  },

  // ---- grid ----
  gridTemplateColumns: {
    group: 'grid',
    css: 'grid-template-columns',
    schema: v.gridTemplate,
    label: 'Columns',
  },
  gridTemplateRows: {
    group: 'grid',
    css: 'grid-template-rows',
    schema: v.gridTemplate,
    label: 'Rows',
  },
  gridColumn: { group: 'grid', css: 'grid-column', schema: v.gridPlacement, label: 'Column span' },
  gridRow: { group: 'grid', css: 'grid-row', schema: v.gridPlacement, label: 'Row span' },

  // ---- flex child ----
  alignSelf: {
    group: 'flexChild',
    css: 'align-self',
    schema: e(['auto', 'flex-start', 'center', 'flex-end', 'stretch', 'baseline']),
    label: 'Align self',
  },
  flexGrow: {
    group: 'flexChild',
    css: 'flex-grow',
    schema: z.number().min(0).max(100),
    label: 'Grow',
  },
  flexShrink: {
    group: 'flexChild',
    css: 'flex-shrink',
    schema: z.number().min(0).max(100),
    label: 'Shrink',
  },
  flexBasis: { group: 'flexChild', css: 'flex-basis', schema: v.sizeValue, label: 'Basis' },
  order: {
    group: 'flexChild',
    css: 'order',
    schema: z.number().int().min(-100).max(100),
    label: 'Order',
  },

  // ---- size ----
  width: {
    group: 'size',
    css: 'width',
    schema: v.sizeValue,
    tokens: ['dimension'],
    label: 'Width',
  },
  height: {
    group: 'size',
    css: 'height',
    schema: v.sizeValue,
    tokens: ['dimension'],
    label: 'Height',
  },
  minWidth: {
    group: 'size',
    css: 'min-width',
    schema: v.minMaxSize,
    tokens: ['dimension'],
    label: 'Min W',
  },
  maxWidth: {
    group: 'size',
    css: 'max-width',
    schema: v.minMaxSize,
    tokens: ['dimension'],
    label: 'Max W',
  },
  minHeight: {
    group: 'size',
    css: 'min-height',
    schema: v.minMaxSize,
    tokens: ['dimension'],
    label: 'Min H',
  },
  maxHeight: {
    group: 'size',
    css: 'max-height',
    schema: v.minMaxSize,
    tokens: ['dimension'],
    label: 'Max H',
  },
  aspectRatio: {
    group: 'size',
    css: 'aspect-ratio',
    schema: z.union([
      z.literal('auto'),
      z.string().regex(/^\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?$/),
      z.number().positive(),
    ]),
    label: 'Aspect',
  },

  // ---- spacing ----
  paddingTop: spacing('Padding top', 'padding-top'),
  paddingRight: spacing('Padding right', 'padding-right'),
  paddingBottom: spacing('Padding bottom', 'padding-bottom'),
  paddingLeft: spacing('Padding left', 'padding-left'),
  marginTop: { ...spacing('Margin top', 'margin-top'), schema: v.inset },
  marginRight: { ...spacing('Margin right', 'margin-right'), schema: v.inset },
  marginBottom: { ...spacing('Margin bottom', 'margin-bottom'), schema: v.inset },
  marginLeft: { ...spacing('Margin left', 'margin-left'), schema: v.inset },

  // ---- position (only meaningful with positioning: 'absolute') ----
  top: { group: 'position', css: 'top', schema: v.inset, tokens: ['dimension'], label: 'Top' },
  right: {
    group: 'position',
    css: 'right',
    schema: v.inset,
    tokens: ['dimension'],
    label: 'Right',
  },
  bottom: {
    group: 'position',
    css: 'bottom',
    schema: v.inset,
    tokens: ['dimension'],
    label: 'Bottom',
  },
  left: { group: 'position', css: 'left', schema: v.inset, tokens: ['dimension'], label: 'Left' },
  zIndex: { group: 'position', css: 'z-index', schema: v.zIndex, label: 'Z' },

  // ---- typography ----
  fontFamily: {
    group: 'typography',
    css: 'font-family',
    schema: v.fontFamily,
    tokens: ['fontFamily'],
    label: 'Font',
  },
  fontSize: {
    group: 'typography',
    css: 'font-size',
    schema: v.length,
    tokens: ['fontSize', 'dimension'],
    label: 'Size',
  },
  fontWeight: {
    group: 'typography',
    css: 'font-weight',
    schema: v.fontWeight,
    tokens: ['fontWeight'],
    label: 'Weight',
  },
  fontStyle: {
    group: 'typography',
    css: 'font-style',
    schema: e(['normal', 'italic']),
    label: 'Style',
  },
  lineHeight: {
    group: 'typography',
    css: 'line-height',
    schema: v.lineHeight,
    tokens: ['lineHeight'],
    label: 'Line height',
  },
  letterSpacing: {
    group: 'typography',
    css: 'letter-spacing',
    schema: z.union([v.length, z.literal('normal')]),
    tokens: ['dimension'],
    label: 'Letter spacing',
  },
  textAlign: {
    group: 'typography',
    css: 'text-align',
    schema: e(['left', 'center', 'right', 'justify']),
    label: 'Align',
  },
  textTransform: {
    group: 'typography',
    css: 'text-transform',
    schema: e(['none', 'uppercase', 'lowercase', 'capitalize']),
    label: 'Case',
  },
  textDecoration: {
    group: 'typography',
    css: 'text-decoration-line',
    schema: e(['none', 'underline', 'line-through']),
    label: 'Decoration',
  },
  whiteSpace: {
    group: 'typography',
    css: 'white-space',
    schema: e(['normal', 'nowrap', 'pre-wrap']),
    label: 'Wrap',
  },
  color: {
    group: 'typography',
    css: 'color',
    schema: v.color,
    tokens: ['color'],
    label: 'Text color',
  },

  // ---- fill ----
  backgroundColor: {
    group: 'fill',
    css: 'background-color',
    schema: v.color,
    tokens: ['color'],
    label: 'Fill',
  },
  backgroundImage: {
    group: 'fill',
    css: 'background-image',
    schema: v.backgroundImage,
    label: 'Gradient',
  },
  objectFit: {
    group: 'fill',
    css: 'object-fit',
    schema: e(['cover', 'contain', 'fill', 'none', 'scale-down']),
    label: 'Fit',
  },

  // ---- border ----
  borderWidth: {
    group: 'border',
    css: 'border-width',
    schema: v.length,
    tokens: ['dimension'],
    label: 'Border',
  },
  borderTopWidth: {
    group: 'border',
    css: 'border-top-width',
    schema: v.length,
    label: 'Border top',
  },
  borderRightWidth: {
    group: 'border',
    css: 'border-right-width',
    schema: v.length,
    label: 'Border right',
  },
  borderBottomWidth: {
    group: 'border',
    css: 'border-bottom-width',
    schema: v.length,
    label: 'Border bottom',
  },
  borderLeftWidth: {
    group: 'border',
    css: 'border-left-width',
    schema: v.length,
    label: 'Border left',
  },
  borderStyle: {
    group: 'border',
    css: 'border-style',
    schema: e(['solid', 'dashed', 'dotted', 'none']),
    label: 'Border style',
  },
  borderColor: {
    group: 'border',
    css: 'border-color',
    schema: v.color,
    tokens: ['color'],
    label: 'Border color',
  },
  borderRadius: {
    group: 'border',
    css: 'border-radius',
    schema: v.length,
    tokens: ['radius', 'dimension'],
    label: 'Radius',
  },
  borderTopLeftRadius: {
    group: 'border',
    css: 'border-top-left-radius',
    schema: v.length,
    tokens: ['radius'],
    label: 'Radius TL',
  },
  borderTopRightRadius: {
    group: 'border',
    css: 'border-top-right-radius',
    schema: v.length,
    tokens: ['radius'],
    label: 'Radius TR',
  },
  borderBottomRightRadius: {
    group: 'border',
    css: 'border-bottom-right-radius',
    schema: v.length,
    tokens: ['radius'],
    label: 'Radius BR',
  },
  borderBottomLeftRadius: {
    group: 'border',
    css: 'border-bottom-left-radius',
    schema: v.length,
    tokens: ['radius'],
    label: 'Radius BL',
  },

  // ---- effects ----
  opacity: {
    group: 'effects',
    css: 'opacity',
    schema: v.opacity,
    tokens: ['number'],
    label: 'Opacity',
  },
  boxShadow: {
    group: 'effects',
    css: 'box-shadow',
    schema: v.boxShadow,
    tokens: ['shadow'],
    label: 'Shadow',
  },
  rotate: { group: 'effects', css: 'rotate', schema: v.transformNumber, label: 'Rotate (deg)' },
  scale: { group: 'effects', css: 'scale', schema: z.number().min(0).max(10), label: 'Scale' },
  translateX: { group: 'effects', css: '--cd-tx', schema: v.length, label: 'Offset X' },
  translateY: { group: 'effects', css: '--cd-ty', schema: v.length, label: 'Offset Y' },
  blur: { group: 'effects', css: '--cd-blur', schema: v.length, label: 'Blur' },
  cursor: {
    group: 'effects',
    css: 'cursor',
    schema: e(['auto', 'default', 'pointer', 'text', 'not-allowed']),
    label: 'Cursor',
  },
} as const satisfies Record<string, PropDef>;

export type StylePropName = keyof typeof STYLE_PROPS;
export const STYLE_PROP_NAMES = Object.keys(STYLE_PROPS) as StylePropName[];

type Literal<K extends StylePropName> = z.infer<(typeof STYLE_PROPS)[K]['schema']>;
export type StyleValue<K extends StylePropName = StylePropName> = Literal<K> | v.TokenRef;
export type StyleProps = { [K in StylePropName]?: Literal<K> | v.TokenRef };

export function isStyleProp(name: string): name is StylePropName {
  return Object.prototype.hasOwnProperty.call(STYLE_PROPS, name);
}

export const styleProps: z.ZodType<StyleProps> = z
  .object(
    Object.fromEntries(
      STYLE_PROP_NAMES.map((k) => [k, z.union([STYLE_PROPS[k].schema, v.tokenRef]).optional()]),
    ) as unknown as Record<StylePropName, z.ZodOptional<z.ZodType>>,
  )
  .strict() as unknown as z.ZodType<StyleProps>;

/** Validate a single prop value (used by setStyle ops). */
export function validateStyleValue(name: string, value: unknown): z.ZodSafeParseResult<unknown> {
  if (!isStyleProp(name)) {
    return z.never({ error: `Unknown style prop "${name}"` }).safeParse(value);
  }
  return z.union([STYLE_PROPS[name].schema, v.tokenRef]).safeParse(value);
}

export const BREAKPOINTS = ['base', 'md', 'lg'] as const;
export type Breakpoint = (typeof BREAKPOINTS)[number];
export const breakpoint = z.enum(BREAKPOINTS);

/** Per-breakpoint style: mobile-first base plus md/lg overrides. */
export const responsiveStyle = z
  .object({ base: styleProps.optional(), md: styleProps.optional(), lg: styleProps.optional() })
  .strict();
export type ResponsiveStyle = z.infer<typeof responsiveStyle>;

/** Resolve a prop at a breakpoint by cascading base → md → lg. */
export function resolveAt<K extends StylePropName>(
  style: ResponsiveStyle,
  prop: K,
  bp: Breakpoint,
): { value: StyleProps[K] | undefined; from: Breakpoint | null } {
  const order: Breakpoint[] =
    bp === 'base' ? ['base'] : bp === 'md' ? ['md', 'base'] : ['lg', 'md', 'base'];
  for (const b of order) {
    const val = style[b]?.[prop];
    if (val !== undefined) return { value: val as StyleProps[K], from: b };
  }
  return { value: undefined, from: null };
}
