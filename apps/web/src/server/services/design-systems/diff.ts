/**
 * "What changes if this project uses that design system?" (Story 4.3). Pure: compares two specs
 * from the point of view of one DesignDoc — only tokens and components the doc actually uses
 * (directly, through its overrides, or inside the components it instantiates) are reported.
 * Also used to explain an upgrade between two versions of the same system (Story 4.2).
 */
import {
  isTokenRef,
  isValidTokenValue,
  resolveToken,
  type ComponentDef,
  type DesignDoc,
  type DesignSystemSpec,
  type Node,
  type ResponsiveStyle,
} from '@crunch/doc-model';
import { stableStringify } from './spec';

export interface TokenChange {
  path: string;
  kind: 'missing' | 'changed' | 'type-changed';
  from: string;
  to: string | null;
  /** Doc nodes that reference the token (directly or through a component). */
  nodeCount: number;
}

export interface ComponentChange {
  id: string;
  name: string;
  kind: 'missing' | 'changed';
  instanceCount: number;
  /** Variant values instances use that the target no longer offers, e.g. "variant=ghost". */
  missingVariants: string[];
  /** Used only inside another component (not instantiated directly by the doc). */
  nested: boolean;
}

export interface ThemeTokenChange {
  theme: string;
  path: string;
  from: string;
  to: string;
}

export interface SystemDiff {
  tokens: TokenChange[];
  components: ComponentChange[];
  /** Token paths the doc uses, total (for "N of M unchanged"). */
  usedTokens: number;
  usedComponents: number;
  breakpoints: {
    from: DesignSystemSpec['breakpoints'];
    to: DesignSystemSpec['breakpoints'];
  } | null;
  themesRemoved: string[];
  /** Used tokens whose value under a theme both sides define changes (beyond base changes). */
  themeTokens: ThemeTokenChange[];
  /** Project token overrides that won't apply (unknown token or wrong type in the target). */
  overridesDropped: string[];
  /** Nothing the doc uses changes. */
  unchanged: boolean;
}

function styleTokens(style: ResponsiveStyle | undefined, add: (path: string) => void) {
  if (!style) return;
  for (const bp of [style.base, style.md, style.lg]) {
    if (!bp) continue;
    for (const v of Object.values(bp)) if (isTokenRef(v)) add(v.token);
  }
}

function componentTokens(
  spec: DesignSystemSpec,
  id: string,
  add: (path: string) => void,
  seen = new Set<string>(),
) {
  const c = spec.components[id];
  if (!c || seen.has(id)) return;
  seen.add(id);
  for (const n of Object.values(c.nodes)) {
    styleTokens(n.style, add);
    if (n.type === 'instance') componentTokens(spec, n.componentRef.componentId, add, seen);
  }
  for (const vs of c.variantStyles) styleTokens(vs.style, add);
}

/** Component ids an instance of `id` renders, itself included (nested instances, any depth). */
function componentClosure(spec: DesignSystemSpec, id: string, out: Set<string>) {
  if (out.has(id)) return;
  out.add(id);
  const c = spec.components[id];
  if (!c) return;
  for (const n of Object.values(c.nodes))
    if (n.type === 'instance') componentClosure(spec, n.componentRef.componentId, out);
}

function display(spec: DesignSystemSpec, path: string, theme?: string): string {
  try {
    return String(resolveToken(spec.tokens, path, theme ? spec.themes[theme] : undefined));
  } catch {
    return 'unresolved';
  }
}

const componentShape = (c: ComponentDef) =>
  stableStringify({
    props: c.props,
    variants: c.variants,
    rootNodeId: c.rootNodeId,
    nodes: c.nodes,
    variantStyles: c.variantStyles,
  });

export function diffSystemsForDoc(
  doc: DesignDoc,
  from: DesignSystemSpec,
  to: DesignSystemSpec,
): SystemDiff {
  const tokenNodes = new Map<string, Set<string>>();
  const instances = new Map<string, Extract<Node, { type: 'instance' }>[]>();
  /** component id -> doc instances that render it (directly or nested). */
  const uses = new Map<string, number>();

  for (const n of Object.values(doc.nodes)) {
    const add = (p: string) => {
      let s = tokenNodes.get(p);
      if (!s) tokenNodes.set(p, (s = new Set()));
      s.add(n.id);
    };
    styleTokens(n.style, add);
    if (n.type === 'instance') {
      const id = n.componentRef.componentId;
      instances.set(id, [...(instances.get(id) ?? []), n]);
      // Tokens inside the component as either side defines it.
      componentTokens(from, id, add);
      componentTokens(to, id, add);
      const closure = new Set<string>();
      componentClosure(from, id, closure);
      componentClosure(to, id, closure);
      for (const c of closure) uses.set(c, (uses.get(c) ?? 0) + 1);
    }
  }
  for (const s of doc.sliders)
    for (const b of s.bindings)
      if ('token' in b.target && !tokenNodes.has(b.target.token))
        tokenNodes.set(b.target.token, new Set());
  for (const p of Object.keys(doc.tokenOverrides))
    if (!tokenNodes.has(p)) tokenNodes.set(p, new Set());

  const tokens: TokenChange[] = [];
  for (const path of [...tokenNodes.keys()].sort()) {
    const a = from.tokens[path];
    const b = to.tokens[path];
    const nodeCount = tokenNodes.get(path)!.size;
    if (!a && !b) continue; // already broken before the switch; that's lint's job
    const fromValue = a ? display(from, path) : 'missing';
    if (!b) {
      tokens.push({ path, kind: 'missing', from: fromValue, to: null, nodeCount });
      continue;
    }
    const toValue = display(to, path);
    if (a && a.type !== b.type)
      tokens.push({ path, kind: 'type-changed', from: `${a.type}`, to: `${b.type}`, nodeCount });
    else if (fromValue !== toValue)
      tokens.push({ path, kind: 'changed', from: fromValue, to: toValue, nodeCount });
  }

  const components: ComponentChange[] = [];
  for (const id of [...uses.keys()].sort()) {
    const a = from.components[id];
    const b = to.components[id];
    const list = instances.get(id) ?? [];
    const nested = list.length === 0;
    const instanceCount = uses.get(id)!;
    if (!a && !b) continue;
    if (!b) {
      components.push({
        id,
        name: a!.name,
        kind: 'missing',
        instanceCount,
        missingVariants: [],
        nested,
      });
      continue;
    }
    const missingVariants = new Set<string>();
    for (const inst of list)
      for (const [axis, value] of Object.entries(inst.componentRef.variant))
        if (!b.variants[axis]?.options.includes(value)) missingVariants.add(`${axis}=${value}`);
    if (!a || componentShape(a) !== componentShape(b) || missingVariants.size) {
      components.push({
        id,
        name: b.name,
        kind: 'changed',
        instanceCount,
        missingVariants: [...missingVariants].sort(),
        nested,
      });
    }
  }

  const overridesDropped = Object.entries(doc.tokenOverrides)
    .filter(([p, v]) => {
      const def = to.tokens[p];
      return !def || !isValidTokenValue(def.type, v);
    })
    .map(([p]) => p)
    .sort();
  const breakpoints =
    from.breakpoints.md !== to.breakpoints.md || from.breakpoints.lg !== to.breakpoints.lg
      ? { from: from.breakpoints, to: to.breakpoints }
      : null;
  const themesRemoved = Object.keys(from.themes)
    .filter((t) => !to.themes[t])
    .sort();
  const baseChanged = new Set(tokens.map((t) => t.path));
  const themeTokens: ThemeTokenChange[] = [];
  for (const theme of Object.keys(from.themes).sort()) {
    if (!to.themes[theme]) continue;
    for (const path of [...tokenNodes.keys()].sort()) {
      if (baseChanged.has(path) || !from.tokens[path] || !to.tokens[path]) continue;
      const a = display(from, path, theme);
      const b = display(to, path, theme);
      if (a !== b) themeTokens.push({ theme, path, from: a, to: b });
    }
  }

  return {
    tokens,
    components,
    usedTokens: tokenNodes.size,
    usedComponents: uses.size,
    breakpoints,
    themesRemoved,
    themeTokens,
    overridesDropped,
    unchanged:
      !tokens.length &&
      !components.length &&
      !breakpoints &&
      !themesRemoved.length &&
      !themeTokens.length &&
      !overridesDropped.length,
  };
}
