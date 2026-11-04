/**
 * Sample documents for tests, the editor seed and renderer parity checks.
 * Deterministic ids, so snapshot tests are stable.
 */
import { SCHEMA_VERSION, type DesignDoc, type Node } from './schema';
import type { ResponsiveStyle } from './styles';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Spec = DistributiveOmit<Node, 'parentId' | 'children' | 'positioning' | 'style'> & {
  style?: ResponsiveStyle;
  positioning?: 'flow' | 'absolute';
  kids?: Spec[];
};

function build(spec: Spec, parentId: string | null, out: Record<string, Node>): string {
  const { kids = [], style = {}, positioning = 'flow', ...rest } = spec;
  const node = { ...rest, parentId, positioning, style, children: [] as string[] } as Node;
  out[node.id] = node;
  node.children = kids.map((k) => build(k, node.id, out));
  return node.id;
}

/** A small landing page: nav, hero with a Button instance, three-column features. */
export function sampleLandingDoc(): DesignDoc {
  const nodes: Record<string, Node> = {};
  const feature = (i: number, title: string, body: string): Spec => ({
    id: `n_feat${i}card00`,
    type: 'box',
    tag: 'article',
    name: `Feature ${i}`,
    props: {},
    style: {
      base: {
        display: 'flex',
        flexDirection: 'column',
        gap: { token: 'space.2' },
        paddingTop: { token: 'space.6' },
        paddingBottom: { token: 'space.6' },
        paddingLeft: { token: 'space.6' },
        paddingRight: { token: 'space.6' },
        borderRadius: { token: 'radius.lg' },
        backgroundColor: { token: 'color.surface' },
      },
    },
    kids: [
      {
        id: `n_feat${i}title0`,
        type: 'text',
        tag: 'h3',
        props: { text: title },
        style: {
          base: {
            fontSize: { token: 'text.lg' },
            fontWeight: { token: 'weight.semibold' },
            color: { token: 'color.text' },
          },
        },
      },
      {
        id: `n_feat${i}body00`,
        type: 'text',
        tag: 'p',
        props: { text: body },
        style: {
          base: {
            fontSize: { token: 'text.sm' },
            color: { token: 'color.muted' },
            lineHeight: { token: 'leading.normal' },
          },
        },
      },
    ],
  });

  const root = build(
    {
      id: 'n_root000001',
      type: 'box',
      tag: 'main',
      name: 'Page',
      props: {},
      style: {
        base: {
          display: 'flex',
          flexDirection: 'column',
          width: 'fill',
          backgroundColor: { token: 'color.background' },
          fontFamily: { token: 'font.sans' },
        },
      },
      kids: [
        {
          id: 'n_nav0000001',
          type: 'box',
          tag: 'nav',
          name: 'Nav',
          props: {},
          style: {
            base: {
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              paddingTop: { token: 'space.4' },
              paddingBottom: { token: 'space.4' },
              paddingLeft: { token: 'space.6' },
              paddingRight: { token: 'space.6' },
              borderBottomWidth: 1,
              borderStyle: 'solid',
              borderColor: { token: 'color.border' },
            },
          },
          kids: [
            {
              id: 'n_logo000001',
              type: 'text',
              tag: 'span',
              name: 'Logo',
              props: { text: 'Acme' },
              style: {
                base: {
                  fontWeight: { token: 'weight.bold' },
                  fontSize: { token: 'text.lg' },
                  color: { token: 'color.text' },
                },
              },
            },
            {
              id: 'n_navcta0001',
              type: 'instance',
              name: 'Sign up',
              componentRef: { componentId: 'Button', variant: { variant: 'secondary' } },
              props: { values: { label: 'Sign up' } },
            },
          ],
        },
        {
          id: 'n_hero000001',
          type: 'box',
          tag: 'section',
          name: 'Hero',
          props: {},
          style: {
            base: {
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: { token: 'space.6' },
              paddingTop: { token: 'space.16' },
              paddingBottom: { token: 'space.16' },
              paddingLeft: { token: 'space.6' },
              paddingRight: { token: 'space.6' },
            },
            lg: { paddingTop: { token: 'space.24' }, paddingBottom: { token: 'space.24' } },
          },
          kids: [
            {
              id: 'n_herotitle1',
              type: 'text',
              tag: 'h1',
              name: 'Headline',
              props: { text: 'Ship designs your engineers can build.' },
              style: {
                base: {
                  fontSize: { token: 'text.4xl' },
                  fontWeight: { token: 'weight.bold' },
                  lineHeight: { token: 'leading.tight' },
                  color: { token: 'color.text' },
                  maxWidth: '20ch',
                },
                lg: { fontSize: { token: 'text.6xl' } },
              },
            },
            {
              id: 'n_herobody01',
              type: 'text',
              tag: 'p',
              name: 'Subhead',
              props: {
                text: 'Describe what you want. Refine it on a live canvas. Export real code.',
              },
              style: {
                base: {
                  fontSize: { token: 'text.lg' },
                  color: { token: 'color.muted' },
                  maxWidth: '48ch',
                },
              },
            },
            {
              id: 'n_herocta001',
              type: 'instance',
              name: 'CTA',
              componentRef: { componentId: 'Button', variant: { variant: 'primary' } },
              props: { values: { label: 'Get started' } },
            },
          ],
        },
        {
          id: 'n_features01',
          type: 'box',
          tag: 'section',
          name: 'Features',
          props: {},
          style: {
            base: {
              display: 'grid',
              gridTemplateColumns: 'repeat(1, minmax(0, 1fr))',
              gap: { token: 'space.4' },
              paddingLeft: { token: 'space.6' },
              paddingRight: { token: 'space.6' },
              paddingBottom: { token: 'space.16' },
            },
            md: { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' },
          },
          kids: [
            feature(
              1,
              'Live HTML frames',
              'Every frame is real DOM, so what you see is what ships.',
            ),
            feature(2, 'Your design system', 'Tokens and components keep every screen on brand.'),
            feature(3, 'Code handoff', 'Export React + Tailwind straight from the document.'),
          ],
        },
      ],
    },
    null,
    nodes,
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    frames: [
      {
        id: 'f_desktop001',
        name: 'Landing — Desktop',
        rootNodeId: root,
        canvas: { x: 0, y: 0 },
        width: 1280,
        height: 'auto',
        previewBreakpoints: [],
      },
    ],
    nodes,
    sliders: [],
  };
}
