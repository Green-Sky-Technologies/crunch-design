/**
 * DesignDoc: the single source of truth for a project's design (SPEC D1).
 * HTML, React+Tailwind and Figma are all generated from this; nothing is parsed back.
 *
 * Shape: a normalized node store (`nodes`) plus ordered frames (artboards), each pointing at a
 * root node. Tree structure is `parentId` + ordered `children`, and both must agree
 * (see validate.ts).
 */
import { customAlphabet } from 'nanoid';
import { z } from 'zod';
import { breakpoint, responsiveStyle } from './styles';
import { safeHref, safeImageSrc, tokenPath } from './values';

export const SCHEMA_VERSION = 1 as const;

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const nano = customAlphabet(alphabet, 12);
/** Stable, URL-safe id. Also used as the key in Figma plugin data (Epic 8). */
export const newId = (prefix: 'n' | 'f' | 's' | 'c' = 'n') => `${prefix}_${nano()}`;
export const id = z.string().regex(/^[a-z]_[0-9a-zA-Z]{6,32}$/, 'Invalid id');
export type NodeId = string;

export const BOX_TAGS = [
  'div',
  'section',
  'header',
  'footer',
  'nav',
  'main',
  'article',
  'aside',
  'ul',
  'ol',
  'li',
  'form',
  'button',
  'a',
  'figure',
] as const;
export const TEXT_TAGS = [
  'p',
  'span',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'label',
  'a',
  'button',
  'li',
  'blockquote',
  'small',
  'strong',
  'em',
  'code',
] as const;

/** Component prop bindings for nodes inside a component definition. */
const bindings = z
  .object({
    text: z.string().max(64).optional(),
    src: z.string().max(64).optional(),
    hidden: z.string().max(64).optional(),
  })
  .strict();

const nodeBase = {
  id,
  name: z.string().max(120).optional(),
  parentId: id.nullable(),
  children: z.array(id).max(2000),
  positioning: z.enum(['flow', 'absolute']),
  style: responsiveStyle,
  hidden: z.boolean().optional(),
  locked: z.boolean().optional(),
  bind: bindings.optional(),
};

const a11y = {
  ariaLabel: z.string().max(300).optional(),
  role: z
    .enum([
      'button',
      'link',
      'img',
      'list',
      'listitem',
      'navigation',
      'banner',
      'contentinfo',
      'region',
      'presentation',
    ])
    .optional(),
};

export const boxNode = z
  .object({
    ...nodeBase,
    type: z.literal('box'),
    tag: z.enum(BOX_TAGS),
    props: z
      .object({ href: safeHref.optional(), ...a11y })
      .strict()
      .default({}),
  })
  .strict();

export const textNode = z
  .object({
    ...nodeBase,
    type: z.literal('text'),
    tag: z.enum(TEXT_TAGS),
    props: z.object({ text: z.string().max(20_000), href: safeHref.optional(), ...a11y }).strict(),
  })
  .strict();

export const imageNode = z
  .object({
    ...nodeBase,
    type: z.literal('image'),
    props: z.object({ src: safeImageSrc, alt: z.string().max(500), ...a11y }).strict(),
  })
  .strict();

/**
 * Inline SVG (icons, simple vectors, Figma vector import). Validated here and sanitized again by
 * an element/attribute allowlist in the renderer. No scripts, handlers, foreignObject or external refs.
 */
export const svgMarkup = z
  .string()
  .max(200_000)
  .refine(
    (s) => /^\s*<svg[\s>]/i.test(s) && /<\/svg>\s*$/i.test(s),
    'Must be a single <svg> element',
  )
  .refine(
    (s) =>
      !/<script|<foreignObject|\son[a-z]+\s*=|javascript:|<!entity|<iframe|<use[^>]+href\s*=\s*["']?(?!#)/i.test(
        s,
      ),
    'SVG contains disallowed content',
  );
export const svgNode = z
  .object({
    ...nodeBase,
    type: z.literal('svg'),
    props: z.object({ svg: svgMarkup, ...a11y }).strict(),
  })
  .strict();

/** An instance of a design-system component (Epic 4). Its subtree comes from the component definition. */
export const instanceNode = z
  .object({
    ...nodeBase,
    type: z.literal('instance'),
    componentRef: z
      .object({
        componentId: z.string().regex(/^[a-zA-Z][\w-]{0,63}$/),
        variant: z.record(z.string().max(64), z.string().max(64)).default({}),
      })
      .strict(),
    props: z
      .object({
        values: z
          .record(z.string().max(64), z.union([z.string().max(20_000), z.boolean(), z.number()]))
          .default({}),
      })
      .strict()
      .default({ values: {} }),
  })
  .strict();

export const node = z.discriminatedUnion('type', [
  boxNode,
  textNode,
  imageNode,
  svgNode,
  instanceNode,
]);
export type Node = z.infer<typeof node>;
export type NodeType = Node['type'];
export type BoxNode = z.infer<typeof boxNode>;
export type TextNode = z.infer<typeof textNode>;
export type ImageNode = z.infer<typeof imageNode>;
export type SvgNode = z.infer<typeof svgNode>;
export type InstanceNode = z.infer<typeof instanceNode>;

/** Node types that can't have children. */
export const LEAF_TYPES: ReadonlySet<NodeType> = new Set(['text', 'image', 'svg', 'instance']);

export const frame = z
  .object({
    id,
    name: z.string().min(1).max(120),
    rootNodeId: id,
    canvas: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
    /** Viewport width the frame renders at; its active breakpoint derives from this. */
    width: z.number().int().min(160).max(4096),
    /** Fixed height, or 'auto' to grow with content. */
    height: z.union([z.number().int().min(80).max(32_768), z.literal('auto')]),
    /** Extra breakpoints to preview side by side (Story 2.4). */
    previewBreakpoints: z.array(breakpoint).max(3).default([]),
  })
  .strict();
export type Frame = z.infer<typeof frame>;

export const sliderTarget = z.union([
  z.object({ nodeId: id, prop: z.string().max(64), breakpoint }).strict(),
  z.object({ token: tokenPath }).strict(),
]);

export const sliderBinding = z
  .object({
    target: sliderTarget,
    /** linear: value maps min..max directly (in `unit`); stops: piecewise mapping to values. */
    map: z.union([
      z
        .object({
          type: z.literal('linear'),
          from: z.number(),
          to: z.number(),
          unit: z.enum(['px', 'rem', '%', '']).default('px'),
        })
        .strict(),
      z
        .object({
          type: z.literal('stops'),
          stops: z
            .array(z.tuple([z.number(), z.union([z.string().max(200), z.number()])]))
            .min(2)
            .max(32),
        })
        .strict(),
    ]),
  })
  .strict();

/** Agent-generated control (Story 5.8). Moving it applies ops locally, at zero tokens. */
export const slider = z
  .object({
    id,
    label: z.string().min(1).max(60),
    min: z.number(),
    max: z.number(),
    step: z.number().positive(),
    value: z.number(),
    bindings: z.array(sliderBinding).min(1).max(50),
    pinned: z.boolean().default(false),
    createdBy: z.enum(['agent', 'user']).default('agent'),
  })
  .strict()
  .refine(
    (s) => s.min < s.max && s.value >= s.min && s.value <= s.max,
    'Slider value out of range',
  );
export type Slider = z.infer<typeof slider>;
export type SliderBinding = z.infer<typeof sliderBinding>;

export const designDoc = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    frames: z.array(frame).max(200),
    nodes: z.record(id, node),
    sliders: z.array(slider).max(100).default([]),
  })
  .strict();
export type DesignDoc = z.infer<typeof designDoc>;

export function emptyDoc(): DesignDoc {
  return { schemaVersion: SCHEMA_VERSION, frames: [], nodes: {}, sliders: [] };
}
