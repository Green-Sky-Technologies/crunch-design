/**
 * Structural invariants Zod can't express: tree consistency, reachability, leaf rules and
 * references. `parseDoc` = schema + invariants; use it at every trust boundary (API input,
 * agent output, imports, DB reads in tests).
 */
import { designDoc, LEAF_TYPES, type DesignDoc, type Node } from './schema';

export const MAX_NODES = 20_000;

export interface DocIssue {
  path: string;
  message: string;
}

export function checkInvariants(doc: DesignDoc): DocIssue[] {
  const issues: DocIssue[] = [];
  const nodes = doc.nodes;
  const ids = Object.keys(nodes);
  if (ids.length > MAX_NODES)
    issues.push({ path: 'nodes', message: `Too many nodes (max ${MAX_NODES})` });

  for (const [key, n] of Object.entries(nodes)) {
    if (n.id !== key)
      issues.push({ path: `nodes.${key}`, message: 'Node id does not match its key' });
  }

  // children <-> parentId agreement
  for (const n of Object.values(nodes)) {
    if (LEAF_TYPES.has(n.type) && n.children.length > 0) {
      issues.push({
        path: `nodes.${n.id}.children`,
        message: `${n.type} nodes cannot have children`,
      });
    }
    const seen = new Set<string>();
    for (const c of n.children) {
      if (seen.has(c))
        issues.push({ path: `nodes.${n.id}.children`, message: `Duplicate child ${c}` });
      seen.add(c);
      const child = nodes[c];
      if (!child) issues.push({ path: `nodes.${n.id}.children`, message: `Missing child ${c}` });
      else if (child.parentId !== n.id) {
        issues.push({
          path: `nodes.${c}.parentId`,
          message: `Child ${c} does not point back to ${n.id}`,
        });
      }
    }
    if (n.parentId !== null) {
      const parent = nodes[n.parentId];
      if (!parent)
        issues.push({ path: `nodes.${n.id}.parentId`, message: `Missing parent ${n.parentId}` });
      else if (!parent.children.includes(n.id)) {
        issues.push({
          path: `nodes.${n.id}.parentId`,
          message: `Parent ${n.parentId} does not list ${n.id}`,
        });
      }
    }
  }

  // frames: unique ids, valid roots, each node reachable from exactly one root
  const frameIds = new Set<string>();
  const owner = new Map<string, string>();
  for (const f of doc.frames) {
    if (frameIds.has(f.id)) issues.push({ path: `frames.${f.id}`, message: 'Duplicate frame id' });
    frameIds.add(f.id);
    const root = nodes[f.rootNodeId];
    if (!root) {
      issues.push({ path: `frames.${f.id}.rootNodeId`, message: 'Root node missing' });
      continue;
    }
    if (root.parentId !== null)
      issues.push({ path: `frames.${f.id}.rootNodeId`, message: 'Root node must have no parent' });
    const stack = [root.id];
    let guard = 0;
    while (stack.length) {
      const nid = stack.pop()!;
      if (++guard > MAX_NODES + 1) {
        issues.push({ path: `frames.${f.id}`, message: 'Cycle detected' });
        break;
      }
      if (owner.has(nid)) {
        issues.push({
          path: `nodes.${nid}`,
          message: `Node reachable from multiple frames or cycles (${owner.get(nid)}, ${f.id})`,
        });
        continue;
      }
      owner.set(nid, f.id);
      const n = nodes[nid];
      if (n) stack.push(...n.children);
    }
  }
  for (const nid of ids) {
    if (!owner.has(nid))
      issues.push({ path: `nodes.${nid}`, message: 'Orphan node (not reachable from any frame)' });
  }

  // sliders reference existing nodes
  for (const s of doc.sliders) {
    for (const b of s.bindings) {
      if ('nodeId' in b.target && !nodes[b.target.nodeId]) {
        issues.push({
          path: `sliders.${s.id}`,
          message: `Slider binds to missing node ${b.target.nodeId}`,
        });
      }
    }
  }
  return issues;
}

export class DocValidationError extends Error {
  override name = 'DocValidationError';
  constructor(public readonly issues: DocIssue[]) {
    super(
      `Invalid DesignDoc: ${issues
        .slice(0, 3)
        .map((i) => `${i.path}: ${i.message}`)
        .join('; ')}`,
    );
  }
}

/** Parse untrusted input into a valid DesignDoc, or throw DocValidationError. */
export function parseDoc(input: unknown): DesignDoc {
  const r = designDoc.safeParse(input);
  if (!r.success) {
    throw new DocValidationError(
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  const issues = checkInvariants(r.data);
  if (issues.length) throw new DocValidationError(issues);
  return r.data;
}

/** Walk a subtree depth-first (pre-order). */
export function* walk(doc: DesignDoc, rootId: string): Generator<Node> {
  const n = doc.nodes[rootId];
  if (!n) return;
  yield n;
  for (const c of n.children) yield* walk(doc, c);
}

/** Ancestors from parent up to the frame root. */
export function ancestors(doc: DesignDoc, nodeId: string): Node[] {
  const out: Node[] = [];
  let cur = doc.nodes[nodeId]?.parentId ?? null;
  while (cur) {
    const n = doc.nodes[cur];
    if (!n) break;
    out.push(n);
    cur = n.parentId;
  }
  return out;
}

/** The frame containing a node. */
export function frameOf(doc: DesignDoc, nodeId: string) {
  let cur: string | null = nodeId;
  let root: string = nodeId;
  while (cur) {
    root = cur;
    cur = doc.nodes[cur]?.parentId ?? null;
  }
  return doc.frames.find((f) => f.rootNodeId === root);
}
