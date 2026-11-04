/**
 * DesignSystemSpec: tokens, themes, breakpoints, components and guidelines (Epic 4).
 * Stored as design_systems.draft and as published design_system_versions.spec.
 */
import { z } from 'zod';
import { id, node, type Node } from './schema';
import { responsiveStyle } from './styles';
import { themes, tokenMap, type TokenMap } from './tokens';

export const componentProp = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('text'),
      default: z.string().max(2000),
      description: z.string().max(300).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('boolean'),
      default: z.boolean(),
      description: z.string().max(300).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('image'),
      default: z.string().max(4096),
      description: z.string().max(300).optional(),
    })
    .strict(),
]);

export const componentDef = z
  .object({
    id: z.string().regex(/^[a-zA-Z][\w-]{0,63}$/),
    name: z.string().min(1).max(80),
    description: z.string().max(1000).optional(),
    props: z.record(z.string().regex(/^[a-zA-Z][\w]{0,63}$/), componentProp).default({}),
    /** Variant axes, e.g. { variant: { options: ['primary','secondary'], default: 'primary' } }. */
    variants: z
      .record(
        z.string().regex(/^[a-zA-Z][\w]{0,63}$/),
        z
          .object({
            options: z.array(z.string().max(64)).min(1).max(20),
            default: z.string().max(64),
          })
          .strict(),
      )
      .default({}),
    rootNodeId: id,
    nodes: z.record(id, node),
    /** Style overrides applied when every `when` entry matches the instance's variant selection. */
    variantStyles: z
      .array(
        z
          .object({ when: z.record(z.string(), z.string()), nodeId: id, style: responsiveStyle })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type ComponentDef = z.infer<typeof componentDef>;

export const designSystemSpec = z
  .object({
    schemaVersion: z.literal(1),
    tokens: tokenMap,
    themes: themes.default({}),
    breakpoints: z
      .object({ md: z.number().int().min(320).max(4000), lg: z.number().int().min(320).max(4000) })
      .strict()
      .refine((b) => b.md < b.lg, 'md must be smaller than lg')
      .default({ md: 768, lg: 1024 }),
    components: z.record(z.string(), componentDef).default({}),
    /** Free-form brand guidance for the agent (voice, do/don't). Part of the cached prefix. */
    guidelines: z.string().max(20_000).default(''),
  })
  .strict();
export type DesignSystemSpec = z.infer<typeof designSystemSpec>;

// ---------------------------------------------------------------------------------------------
// Starter design system (used for the default workspace system until it's first edited).
// ---------------------------------------------------------------------------------------------

const starterTokens: TokenMap = {
  'color.background': { type: 'color', value: '#ffffff' },
  'color.surface': { type: 'color', value: '#f6f6f4' },
  'color.text': { type: 'color', value: '#18181b' },
  'color.muted': { type: 'color', value: '#6b6b70' },
  'color.border': { type: 'color', value: '#e4e4e7' },
  'color.primary': { type: 'color', value: '#4f46e5' },
  'color.primaryText': { type: 'color', value: '#ffffff' },
  'color.accent': { type: 'color', value: '#f97316' },
  'font.sans': { type: 'fontFamily', value: 'Inter, ui-sans-serif, system-ui, sans-serif' },
  'font.mono': { type: 'fontFamily', value: 'ui-monospace, monospace' },
  'text.xs': { type: 'fontSize', value: '0.75rem' },
  'text.sm': { type: 'fontSize', value: '0.875rem' },
  'text.base': { type: 'fontSize', value: '1rem' },
  'text.lg': { type: 'fontSize', value: '1.125rem' },
  'text.xl': { type: 'fontSize', value: '1.25rem' },
  'text.2xl': { type: 'fontSize', value: '1.5rem' },
  'text.4xl': { type: 'fontSize', value: '2.25rem' },
  'text.6xl': { type: 'fontSize', value: '3.75rem' },
  'weight.regular': { type: 'fontWeight', value: 400 },
  'weight.medium': { type: 'fontWeight', value: 500 },
  'weight.semibold': { type: 'fontWeight', value: 600 },
  'weight.bold': { type: 'fontWeight', value: 700 },
  'leading.tight': { type: 'lineHeight', value: 1.15 },
  'leading.normal': { type: 'lineHeight', value: 1.5 },
  'space.1': { type: 'dimension', value: '0.25rem' },
  'space.2': { type: 'dimension', value: '0.5rem' },
  'space.3': { type: 'dimension', value: '0.75rem' },
  'space.4': { type: 'dimension', value: '1rem' },
  'space.6': { type: 'dimension', value: '1.5rem' },
  'space.8': { type: 'dimension', value: '2rem' },
  'space.12': { type: 'dimension', value: '3rem' },
  'space.16': { type: 'dimension', value: '4rem' },
  'space.24': { type: 'dimension', value: '6rem' },
  'radius.sm': { type: 'radius', value: '0.25rem' },
  'radius.md': { type: 'radius', value: '0.5rem' },
  'radius.lg': { type: 'radius', value: '1rem' },
  'radius.full': { type: 'radius', value: '9999px' },
  'shadow.sm': { type: 'shadow', value: '0 1px 2px rgba(0,0,0,0.06)' },
  'shadow.md': { type: 'shadow', value: '0 4px 12px rgba(0,0,0,0.08)' },
};

const btnNodes: Record<string, Node> = {
  n_btnroot01: {
    id: 'n_btnroot01',
    type: 'box',
    tag: 'button',
    name: 'Button',
    parentId: null,
    children: ['n_btnlabel1'],
    positioning: 'flow',
    props: {},
    style: {
      base: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: { token: 'space.2' },
        paddingTop: { token: 'space.2' },
        paddingBottom: { token: 'space.2' },
        paddingLeft: { token: 'space.4' },
        paddingRight: { token: 'space.4' },
        borderRadius: { token: 'radius.md' },
        backgroundColor: { token: 'color.primary' },
        borderWidth: 0,
        cursor: 'pointer',
      },
    },
  },
  n_btnlabel1: {
    id: 'n_btnlabel1',
    type: 'text',
    tag: 'span',
    name: 'Label',
    parentId: 'n_btnroot01',
    children: [],
    positioning: 'flow',
    bind: { text: 'label' },
    props: { text: 'Button' },
    style: {
      base: {
        color: { token: 'color.primaryText' },
        fontFamily: { token: 'font.sans' },
        fontSize: { token: 'text.sm' },
        fontWeight: { token: 'weight.semibold' },
      },
    },
  },
};

export function starterDesignSystem(): DesignSystemSpec {
  return designSystemSpec.parse({
    schemaVersion: 1,
    tokens: structuredClone(starterTokens),
    themes: {
      dark: {
        'color.background': '#0b0b0f',
        'color.surface': '#16161c',
        'color.text': '#f4f4f5',
        'color.muted': '#a1a1aa',
        'color.border': '#27272a',
      },
    },
    breakpoints: { md: 768, lg: 1024 },
    components: {
      Button: {
        id: 'Button',
        name: 'Button',
        description: 'Primary call-to-action button.',
        props: { label: { type: 'text', default: 'Button' } },
        variants: { variant: { options: ['primary', 'secondary'], default: 'primary' } },
        rootNodeId: 'n_btnroot01',
        nodes: structuredClone(btnNodes),
        variantStyles: [
          {
            when: { variant: 'secondary' },
            nodeId: 'n_btnroot01',
            style: {
              base: {
                backgroundColor: 'transparent',
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: { token: 'color.border' },
              },
            },
          },
          {
            when: { variant: 'secondary' },
            nodeId: 'n_btnlabel1',
            style: { base: { color: { token: 'color.text' } } },
          },
        ],
      },
    },
    guidelines: '',
  });
}
