/** Tree navigation and layer-list helpers over a DesignDoc (Story 3.2). */
import { LEAF_TYPES, type DesignDoc, type Node } from '@crunch/doc-model';

export function ancestors(doc: DesignDoc, id: string): string[] {
  const out: string[] = [];
  let n = doc.nodes[id];
  for (let guard = 0; n?.parentId && guard < 10_000; guard++) {
    out.push(n.parentId);
    n = doc.nodes[n.parentId];
  }
  return out;
}

/** Nearest selectable node at or above `id`: locked nodes defer to their closest unlocked ancestor. */
export function selectableAt(doc: DesignDoc, id: string): string | null {
  let n = doc.nodes[id];
  for (let guard = 0; n && guard < 10_000; guard++) {
    if (!n.locked) return n.id;
    if (!n.parentId) return null;
    n = doc.nodes[n.parentId];
  }
  return null;
}

/**
 * A node is locked if it or any ancestor is. Locked nodes can be selected (to inspect or unlock)
 * but never edited: no delete, move, resize, text, style or visibility changes, and nothing can
 * be dropped into them.
 */
export function isLocked(doc: DesignDoc, id: string): boolean {
  let n = doc.nodes[id];
  for (let guard = 0; n && guard < 10_000; guard++) {
    if (n.locked) return true;
    if (!n.parentId) return false;
    n = doc.nodes[n.parentId];
  }
  return false;
}

/** Esc: the parent of a node, or null at a frame root (the frame itself becomes selected). */
export const parentOf = (doc: DesignDoc, id: string): string | null =>
  doc.nodes[id]?.parentId ?? null;

/** Enter: the first visible child, if any. */
export function firstChild(doc: DesignDoc, id: string): string | null {
  const n = doc.nodes[id];
  if (!n) return null;
  return n.children.find((c) => !doc.nodes[c]?.hidden) ?? n.children[0] ?? null;
}

/** Tab / Shift+Tab: next or previous sibling, wrapping. */
export function sibling(doc: DesignDoc, id: string, dir: 1 | -1): string | null {
  const n = doc.nodes[id];
  if (!n?.parentId) return null;
  const sibs = doc.nodes[n.parentId]!.children;
  if (sibs.length < 2) return null;
  const i = sibs.indexOf(id);
  return sibs[(i + dir + sibs.length) % sibs.length]!;
}

/** Shift-click toggles membership; a plain click replaces the selection. */
export function toggleSelection(
  current: readonly string[],
  id: string,
  additive: boolean,
): string[] {
  if (!additive) return [id];
  return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
}

/**
 * Drop nodes whose ancestor is also selected (deleting or moving a parent covers its children),
 * and frame roots (they can't be removed or moved).
 */
export function topLevelSelection(doc: DesignDoc, ids: readonly string[]): string[] {
  const movable = ids.filter((id) => doc.nodes[id]?.parentId);
  const set = new Set(movable);
  return movable.filter((id) => !ancestors(doc, id).some((a) => set.has(a)));
}

export const isContainer = (n: Node | undefined): boolean => !!n && !LEAF_TYPES.has(n.type);

/** Human label for a node: its name, else a text snippet, else its tag or type. */
export function nodeLabel(n: Node): string {
  if (n.name) return n.name;
  if (n.type === 'text') {
    const t = n.props.text.trim().replace(/\s+/g, ' ');
    return t.length > 32 ? `${t.slice(0, 31)}…` : t || n.tag;
  }
  if (n.type === 'instance') return n.componentRef.componentId;
  if (n.type === 'image') return n.props.alt || 'Image';
  if (n.type === 'svg') return 'Vector';
  return n.tag;
}

export interface LayerRow {
  id: string;
  depth: number;
  label: string;
  type: Node['type'];
  hasChildren: boolean;
  expanded: boolean;
  hidden: boolean;
  locked: boolean;
}

/** Visible rows of a frame's layer tree, pre-order, honouring the expanded set. */
export function layerRows(
  doc: DesignDoc,
  rootId: string,
  expanded: ReadonlySet<string>,
): LayerRow[] {
  const rows: LayerRow[] = [];
  const visit = (id: string, depth: number) => {
    const n = doc.nodes[id];
    if (!n) return;
    const open = expanded.has(id);
    rows.push({
      id,
      depth,
      label: nodeLabel(n),
      type: n.type,
      hasChildren: n.children.length > 0,
      expanded: open,
      hidden: !!n.hidden,
      locked: !!n.locked,
    });
    if (open) for (const c of n.children) visit(c, depth + 1);
  };
  visit(rootId, 0);
  return rows;
}

const TAG_NAMES: Record<string, string> = {
  a: 'Link',
  p: 'Paragraph',
  span: 'Text',
  h1: 'Heading',
  h2: 'Heading',
  h3: 'Heading',
  h4: 'Heading',
  h5: 'Heading',
  h6: 'Heading',
  div: 'Box',
  ul: 'List',
  ol: 'List',
  li: 'List item',
  nav: 'Nav',
  blockquote: 'Quote',
  em: 'Emphasis',
  img: 'Image',
  svg: 'Vector',
};

/** The HTML tag a node renders as (instances show as `component`). */
export function nodeTag(n: Node): string {
  if (n.type === 'box' || n.type === 'text') return n.tag;
  if (n.type === 'image') return 'img';
  if (n.type === 'svg') return 'svg';
  return 'component';
}

/**
 * Semantic layer name for the edit panel's tree: the layout a box establishes (flex row → "Row",
 * flex column → "Column", grid → "Grid"), else the node's own name, else its tag, capitalised
 * ("Header", "Link", "Heading"). Instances use their component's name when it's known.
 */
export function layerName(n: Node, componentName?: string): string {
  if (n.type === 'box') {
    const s = n.style;
    const display = s.lg?.display ?? s.md?.display ?? s.base?.display;
    const dir = s.lg?.flexDirection ?? s.md?.flexDirection ?? s.base?.flexDirection;
    if (display === 'grid') return 'Grid';
    if (display === 'flex' || display === 'inline-flex')
      return dir === 'column' || dir === 'column-reverse' ? 'Column' : 'Row';
  }
  if (n.name) return n.name;
  if (n.type === 'instance') return componentName ?? n.componentRef.componentId;
  const tag = nodeTag(n);
  return TAG_NAMES[tag] ?? tag.charAt(0).toUpperCase() + tag.slice(1);
}

/** Quoted, single-line, truncated preview of a text node's content ('' for other nodes). */
export function textPreview(n: Node, max = 40): string {
  if (n.type !== 'text') return '';
  const t = n.props.text.trim().replace(/\s+/g, ' ');
  if (!t) return '';
  return `“${t.length > max ? `${t.slice(0, max - 1)}…` : t}”`;
}
