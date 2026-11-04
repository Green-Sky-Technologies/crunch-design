/**
 * Compact views of a DesignDoc for the model (SPEC §2.3): an outline of the whole document and
 * full JSON for just the relevant subtree. The model never gets the whole doc for a local change.
 */
import { walk, type DesignDoc, type Node } from '@crunch/doc-model';

const SHORT_TEXT = 48;

function shortText(n: Node): string {
  if (n.type === 'text') {
    const t = n.props.text.replace(/\s+/g, ' ').trim();
    return t.length > SHORT_TEXT ? `${t.slice(0, SHORT_TEXT - 1)}…` : t;
  }
  if (n.type === 'image') return n.props.alt.slice(0, SHORT_TEXT);
  return '';
}

function label(n: Node): string {
  const kind =
    n.type === 'instance'
      ? `instance(${n.componentRef.componentId})`
      : n.type === 'box' || n.type === 'text'
        ? `${n.type}<${n.tag}>`
        : n.type;
  const parts = [n.id, kind];
  if (n.name) parts.push(JSON.stringify(n.name));
  const t = shortText(n);
  if (t) parts.push(`— ${JSON.stringify(t)}`);
  if (n.positioning === 'absolute') parts.push('[absolute]');
  if (n.hidden) parts.push('[hidden]');
  return parts.join(' ');
}

export interface OutlineOptions {
  frameId?: string;
  maxDepth?: number;
  /** Hard cap on lines, to bound tokens on huge docs. */
  maxLines?: number;
}

/** One line per node, indented by depth. Deterministic for a given doc. */
export function outline(doc: DesignDoc, opts: OutlineOptions = {}): string {
  const maxDepth = opts.maxDepth ?? 6;
  const maxLines = opts.maxLines ?? 600;
  const frames = opts.frameId ? doc.frames.filter((f) => f.id === opts.frameId) : doc.frames;
  const lines: string[] = [];
  let truncated = false;
  const visit = (id: string, depth: number) => {
    const n = doc.nodes[id];
    if (!n) return;
    if (lines.length >= maxLines) {
      truncated = true;
      return;
    }
    lines.push(`${'  '.repeat(depth + 1)}${label(n)}`);
    if (depth + 1 >= maxDepth) {
      if (n.children.length) lines.push(`${'  '.repeat(depth + 2)}… ${n.children.length} children`);
      return;
    }
    for (const c of n.children) visit(c, depth + 1);
  };
  for (const f of frames) {
    lines.push(`frame ${f.id} ${JSON.stringify(f.name)} width=${f.width} root=${f.rootNodeId}`);
    visit(f.rootNodeId, 0);
  }
  if (!frames.length) lines.push('(no frames)');
  if (truncated) lines.push(`… outline truncated at ${maxLines} lines; use get_subtree`);
  return lines.join('\n');
}

export interface SubtreeResult {
  rootId: string;
  /** Pre-order; children beyond maxDepth are listed by id only. */
  nodes: Node[];
  truncated: boolean;
}

export function subtree(
  doc: DesignDoc,
  nodeId: string,
  opts: { maxDepth?: number; maxNodes?: number } = {},
): SubtreeResult | null {
  const root = doc.nodes[nodeId];
  if (!root) return null;
  const maxDepth = opts.maxDepth ?? 50;
  const maxNodes = opts.maxNodes ?? 400;
  const nodes: Node[] = [];
  let truncated = false;
  const visit = (id: string, depth: number) => {
    const n = doc.nodes[id];
    if (!n) return;
    if (nodes.length >= maxNodes) {
      truncated = true;
      return;
    }
    nodes.push(n);
    if (depth + 1 >= maxDepth) {
      if (n.children.length) truncated = true;
      return;
    }
    for (const c of n.children) visit(c, depth + 1);
  };
  visit(nodeId, 0);
  return { rootId: nodeId, nodes, truncated };
}

/** Ids of a node and all its descendants. */
export function subtreeIds(doc: DesignDoc, nodeId: string): Set<string> {
  const ids = new Set<string>();
  for (const n of walk(doc, nodeId)) ids.add(n.id);
  return ids;
}

/** Path of names from the frame root to a node, for a little context around a scoped edit. */
export function breadcrumb(doc: DesignDoc, nodeId: string): string {
  const parts: string[] = [];
  let cur: Node | undefined = doc.nodes[nodeId];
  while (cur) {
    parts.unshift(cur.name ?? (cur.type === 'box' || cur.type === 'text' ? cur.tag : cur.type));
    cur = cur.parentId ? doc.nodes[cur.parentId] : undefined;
  }
  return parts.join(' › ');
}
