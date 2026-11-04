/**
 * describe(): DesignDoc node -> element description (tag, attributes, class, text/svg).
 * The single source of markup for both renderers, which is what keeps them identical.
 * Also expands design-system component instances into concrete parts.
 */
import {
  type ComponentDef,
  type DesignSystemSpec,
  type Node,
  type ResponsiveStyle,
} from '@crunch/doc-model';
import { sanitizeSvg } from './svg';

export interface RenderOptions {
  /** Add data-cd-id attributes for canvas hit-testing (true on the canvas, false in exports). */
  annotate: boolean;
  /** Render hidden nodes (dimmed) instead of display:none. */
  showHidden: boolean;
}

export const DEFAULT_OPTIONS: RenderOptions = { annotate: true, showHidden: false };

/** A concrete node to render: a doc node, or a part of an expanded component instance. */
export interface RNode {
  /** Unique key and class suffix: node id, or `${instanceId}-${partId}`. */
  key: string;
  /** Doc node this element belongs to (the instance id for instance parts). */
  docId: string;
  /** Component part id, if part of an instance. */
  partId?: string;
  node: Node;
  style: ResponsiveStyle;
  hidden: boolean;
  children: RNode[] | null; // null: children are doc children (rendered by the caller)
}

export interface ElementDesc {
  tag: string;
  attrs: Record<string, string>;
  /** Text content (escaped by the renderer) for text nodes. */
  text?: string;
  /** Sanitized inner SVG markup for svg nodes. */
  svgHtml?: string;
  /** Void element (img). */
  void?: boolean;
}

export const classFor = (key: string) => `cd-${key}`;

const MAX_INSTANCE_DEPTH = 5;

function mergeStyle(a: ResponsiveStyle, b: ResponsiveStyle | undefined): ResponsiveStyle {
  if (!b) return a;
  return {
    base: { ...a.base, ...b.base },
    md: a.md || b.md ? { ...a.md, ...b.md } : undefined,
    lg: a.lg || b.lg ? { ...a.lg, ...b.lg } : undefined,
  };
}

/** Expand an instance node into concrete parts using its component definition. */
export function expandInstance(
  inst: Extract<Node, { type: 'instance' }>,
  ds: DesignSystemSpec,
  depth = 0,
): RNode {
  const comp: ComponentDef | undefined = ds.components[inst.componentRef.componentId];
  if (!comp || depth > MAX_INSTANCE_DEPTH) {
    // Missing component: render a visible placeholder so the problem is obvious on the canvas.
    const placeholder: Node = {
      id: inst.id,
      type: 'text',
      tag: 'span',
      parentId: inst.parentId,
      children: [],
      positioning: inst.positioning,
      style: inst.style,
      props: { text: `Missing component: ${inst.componentRef.componentId}` },
    };
    return {
      key: inst.id,
      docId: inst.id,
      node: placeholder,
      style: inst.style,
      hidden: !!inst.hidden,
      children: [],
    };
  }
  const variant: Record<string, string> = {};
  for (const [axis, def] of Object.entries(comp.variants)) {
    variant[axis] = inst.componentRef.variant[axis] ?? def.default;
  }
  const values = inst.props.values;
  const propValue = (name: string) => values[name] ?? comp.props[name]?.default;

  const build = (partId: string, isRoot: boolean): RNode => {
    const part = comp.nodes[partId]!;
    let style = part.style;
    for (const vs of comp.variantStyles) {
      if (vs.nodeId === partId && Object.entries(vs.when).every(([k, v]) => variant[k] === v)) {
        style = mergeStyle(style, vs.style);
      }
    }
    if (isRoot) style = mergeStyle(style, inst.style); // instance overrides win
    let node: Node = part;
    if (part.bind?.text && part.type === 'text') {
      const v = propValue(part.bind.text);
      if (v !== undefined) node = { ...part, props: { ...part.props, text: String(v) } };
    }
    if (part.bind?.src && part.type === 'image') {
      const v = propValue(part.bind.src);
      if (typeof v === 'string') node = { ...part, props: { ...part.props, src: v } };
    }
    const hiddenByProp = part.bind?.hidden ? propValue(part.bind.hidden) === false : false;
    const key = `${inst.id}-${partId}`;
    if (node.type === 'instance') {
      const nested = expandInstance({ ...node, id: key }, ds, depth + 1);
      return { ...nested, key, docId: inst.id, partId };
    }
    return {
      key,
      docId: inst.id,
      partId,
      node: isRoot ? { ...node, positioning: inst.positioning } : node,
      style,
      hidden: hiddenByProp || (isRoot && !!inst.hidden) || !!part.hidden,
      children: part.children.map((c) => build(c, false)),
    };
  };
  return build(comp.rootNodeId, true);
}

/** RNode for a plain doc node (children rendered by the caller from the doc). */
export function rnodeFor(node: Node, ds: DesignSystemSpec): RNode {
  if (node.type === 'instance') return expandInstance(node, ds);
  return {
    key: node.id,
    docId: node.id,
    node,
    style: node.style,
    hidden: !!node.hidden,
    children: null,
  };
}

export function describe(r: RNode, opts: RenderOptions): ElementDesc {
  const n = r.node;
  const attrs: Record<string, string> = { class: classFor(r.key) };
  if (opts.annotate) {
    attrs['data-cd-id'] = r.docId;
    if (r.partId) attrs['data-cd-part'] = r.partId;
    if (r.hidden && opts.showHidden) attrs['data-cd-hidden'] = '';
  }
  const a11y = (p: { ariaLabel?: string; role?: string }) => {
    if (p.ariaLabel) attrs['aria-label'] = p.ariaLabel;
    if (p.role) attrs.role = p.role;
  };
  switch (n.type) {
    case 'box': {
      a11y(n.props);
      if (n.tag === 'a' && n.props.href) attrs.href = n.props.href;
      if (n.tag === 'button') attrs.type = 'button';
      return { tag: n.tag, attrs };
    }
    case 'text': {
      a11y(n.props);
      if (n.tag === 'a' && n.props.href) attrs.href = n.props.href;
      if (n.tag === 'button') attrs.type = 'button';
      return { tag: n.tag, attrs, text: n.props.text };
    }
    case 'image':
      a11y(n.props);
      attrs.src = n.props.src;
      attrs.alt = n.props.alt;
      attrs.loading = 'lazy';
      attrs.decoding = 'async';
      return { tag: 'img', attrs, void: true };
    case 'svg': {
      a11y(n.props);
      const clean = sanitizeSvg(n.props.svg);
      // Unwrap the outer <svg …> so we can own its class/attrs; keep its viewBox etc.
      const m = /^<svg([^>]*)>([\s\S]*)<\/svg>$/.exec(clean);
      const inner = m?.[2] ?? '';
      for (const am of (m?.[1] ?? '').matchAll(/([\w:-]+)="([^"]*)"/g)) {
        if (am[1] !== 'class')
          attrs[am[1]!] = am[2]!
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');
      }
      attrs.xmlns ??= 'http://www.w3.org/2000/svg';
      return { tag: 'svg', attrs, svgHtml: inner };
    }
    case 'instance':
      // Instances are expanded before describe(); reaching here means a bug.
      return { tag: 'div', attrs };
  }
}
