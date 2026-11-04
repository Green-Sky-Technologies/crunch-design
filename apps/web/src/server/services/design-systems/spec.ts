/**
 * Pure DesignSystemSpec validation (Story 4.1). Zod checks the shape (@crunch/doc-model's
 * `designSystemSpec`); this adds the cross-references Zod can't express: aliases point at real
 * tokens of a compatible type with no cycles, themes override real tokens with valid values, and
 * every component is a consistent, acyclic node tree whose bindings and variants line up.
 *
 * Framework-free and DB-free, so the editor can run it in the browser for instant feedback and the
 * service runs the same check before every write. An invalid spec is never stored.
 */
import {
  designSystemSpec,
  isValidTokenValue,
  LEAF_TYPES,
  type ComponentDef,
  type DesignSystemSpec,
  type TokenType,
} from '@crunch/doc-model';

/** Upper bound on a stored spec (JSON bytes). Specs are part of the agent's cached prefix. */
export const MAX_SPEC_BYTES = 2 * 1024 * 1024;

export interface SpecIssue {
  path: string;
  message: string;
}

const LENGTH_TYPES: ReadonlySet<TokenType> = new Set(['dimension', 'radius', 'fontSize']);

/** Alias targets must hold the same kind of value (any length type can alias another). */
export function compatibleTokenTypes(a: TokenType, b: TokenType): boolean {
  return a === b || (LENGTH_TYPES.has(a) && LENGTH_TYPES.has(b));
}

function checkTokens(spec: DesignSystemSpec, issues: SpecIssue[]) {
  const { tokens } = spec;
  for (const [path, def] of Object.entries(tokens)) {
    if (typeof def.value !== 'object') continue;
    const target = tokens[def.value.ref];
    if (!target) {
      issues.push({ path: `tokens.${path}`, message: `Alias to unknown token "${def.value.ref}"` });
      continue;
    }
    if (!compatibleTokenTypes(def.type, target.type)) {
      issues.push({
        path: `tokens.${path}`,
        message: `A ${def.type} token can't alias ${def.value.ref} (${target.type})`,
      });
    }
    // Cycle check: follow the chain until a literal.
    const seen = new Set([path]);
    let cur = def.value.ref;
    while (true) {
      if (seen.has(cur)) {
        issues.push({ path: `tokens.${path}`, message: `Alias cycle through "${cur}"` });
        break;
      }
      seen.add(cur);
      const next = tokens[cur];
      if (!next || typeof next.value !== 'object') break;
      cur = next.value.ref;
    }
  }

  for (const [theme, overrides] of Object.entries(spec.themes)) {
    for (const [path, value] of Object.entries(overrides)) {
      const def = tokens[path];
      const at = `themes.${theme}.${path}`;
      if (!def) {
        issues.push({ path: at, message: `Theme overrides unknown token "${path}"` });
        continue;
      }
      if (typeof value === 'object') {
        const target = tokens[value.ref];
        if (!target) issues.push({ path: at, message: `Alias to unknown token "${value.ref}"` });
        else if (!compatibleTokenTypes(def.type, target.type))
          issues.push({ path: at, message: `Can't alias a ${target.type} token here` });
      } else if (!isValidTokenValue(def.type, value)) {
        issues.push({ path: at, message: `Invalid ${def.type} value` });
      }
    }
  }
}

function checkComponent(key: string, c: ComponentDef, spec: DesignSystemSpec, out: SpecIssue[]) {
  const at = `components.${key}`;
  if (c.id !== key) out.push({ path: at, message: 'Component id does not match its key' });

  for (const [axis, v] of Object.entries(c.variants)) {
    if (!v.options.includes(v.default))
      out.push({ path: `${at}.variants.${axis}`, message: 'Default must be one of the options' });
    if (new Set(v.options).size !== v.options.length)
      out.push({ path: `${at}.variants.${axis}`, message: 'Duplicate variant option' });
  }

  const nodes = c.nodes;
  for (const [nid, n] of Object.entries(nodes)) {
    if (n.id !== nid) out.push({ path: `${at}.nodes.${nid}`, message: 'Node id mismatch' });
  }
  const root = nodes[c.rootNodeId];
  if (!root) {
    out.push({ path: `${at}.rootNodeId`, message: 'Root node missing' });
    return;
  }
  if (root.parentId !== null)
    out.push({ path: `${at}.rootNodeId`, message: 'Root node must have no parent' });

  // Tree consistency and reachability from the root.
  const reached = new Set<string>();
  const stack = [root.id];
  while (stack.length) {
    const nid = stack.pop()!;
    if (reached.has(nid)) {
      out.push({ path: `${at}.nodes.${nid}`, message: 'Node reachable twice (cycle)' });
      continue;
    }
    reached.add(nid);
    const n = nodes[nid];
    if (!n) continue;
    if (LEAF_TYPES.has(n.type) && n.children.length)
      out.push({ path: `${at}.nodes.${nid}`, message: `${n.type} nodes cannot have children` });
    for (const ch of n.children) {
      const child = nodes[ch];
      if (!child) out.push({ path: `${at}.nodes.${nid}`, message: `Missing child ${ch}` });
      else if (child.parentId !== nid)
        out.push({ path: `${at}.nodes.${ch}`, message: `Child does not point back to ${nid}` });
      stack.push(ch);
    }
  }
  for (const nid of Object.keys(nodes)) {
    if (!reached.has(nid))
      out.push({ path: `${at}.nodes.${nid}`, message: 'Node not reachable from the root' });
  }

  // Bindings reference props of the right type.
  for (const n of Object.values(nodes)) {
    const b = n.bind;
    if (!b) continue;
    const want: [string | undefined, string, string][] = [
      [b.text, 'text', 'text'],
      [b.src, 'image', 'src'],
      [b.hidden, 'boolean', 'hidden'],
    ];
    for (const [prop, type, slot] of want) {
      if (prop === undefined) continue;
      const p = c.props[prop];
      if (!p)
        out.push({ path: `${at}.nodes.${n.id}.bind.${slot}`, message: `Unknown prop "${prop}"` });
      else if (p.type !== type)
        out.push({
          path: `${at}.nodes.${n.id}.bind.${slot}`,
          message: `Prop "${prop}" must be a ${type} prop`,
        });
    }
    if (b.text !== undefined && n.type !== 'text')
      out.push({ path: `${at}.nodes.${n.id}.bind.text`, message: 'Only text nodes bind text' });
    if (b.src !== undefined && n.type !== 'image')
      out.push({ path: `${at}.nodes.${n.id}.bind.src`, message: 'Only image nodes bind src' });
  }

  c.variantStyles.forEach((vs, i) => {
    const p = `${at}.variantStyles.${i}`;
    if (!nodes[vs.nodeId]) out.push({ path: p, message: `Unknown node ${vs.nodeId}` });
    for (const [axis, opt] of Object.entries(vs.when)) {
      const v = c.variants[axis];
      if (!v) out.push({ path: p, message: `Unknown variant axis "${axis}"` });
      else if (!v.options.includes(opt))
        out.push({ path: p, message: `"${opt}" is not an option of ${axis}` });
    }
  });

  for (const n of Object.values(nodes)) {
    if (n.type === 'instance' && !spec.components[n.componentRef.componentId])
      out.push({
        path: `${at}.nodes.${n.id}`,
        message: `Nested instance of unknown component "${n.componentRef.componentId}"`,
      });
  }
}

/** Components may nest instances of other components, but never (transitively) themselves. */
function checkComponentCycles(spec: DesignSystemSpec, out: SpecIssue[]) {
  const deps = new Map<string, string[]>();
  for (const [k, c] of Object.entries(spec.components)) {
    deps.set(
      k,
      Object.values(c.nodes).flatMap((n) =>
        n.type === 'instance' ? [n.componentRef.componentId] : [],
      ),
    );
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (k: string, trail: string[]): void => {
    if (state.get(k) === 'done') return;
    if (state.get(k) === 'visiting') {
      out.push({
        path: `components.${trail[0]}`,
        message: `Component nests itself: ${[...trail, k].join(' → ')}`,
      });
      return;
    }
    state.set(k, 'visiting');
    for (const d of deps.get(k) ?? []) if (deps.has(d)) visit(d, [...trail, k]);
    state.set(k, 'done');
  };
  for (const k of deps.keys()) visit(k, []);
}

/** Cross-reference checks on an already shape-valid spec. Empty = valid. */
export function checkSpecInvariants(spec: DesignSystemSpec): SpecIssue[] {
  const issues: SpecIssue[] = [];
  checkTokens(spec, issues);
  for (const [k, c] of Object.entries(spec.components)) checkComponent(k, c, spec, issues);
  checkComponentCycles(spec, issues);
  return issues;
}

export type SpecParseResult =
  { ok: true; spec: DesignSystemSpec } | { ok: false; issues: SpecIssue[] };

/** Shape + invariants + size. Use at every write boundary. */
export function safeParseSpec(input: unknown): SpecParseResult {
  const r = designSystemSpec.safeParse(input);
  if (!r.success) {
    return {
      ok: false,
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  const issues = checkSpecInvariants(r.data);
  const bytes = JSON.stringify(r.data).length;
  if (bytes > MAX_SPEC_BYTES)
    issues.push({ path: '', message: `Design system is too large (${bytes} bytes)` });
  return issues.length ? { ok: false, issues } : { ok: true, spec: r.data };
}

/** Deterministic JSON (sorted keys) for equality checks between drafts and versions. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function specsEqual(a: DesignSystemSpec, b: DesignSystemSpec): boolean {
  return stableStringify(a) === stableStringify(b);
}
