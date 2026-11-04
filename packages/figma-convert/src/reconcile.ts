/**
 * Update-in-place for re-pushes (Story 8.2). Pure and dependency-free (bundled by the plugin).
 *
 * The plugin collects every node under a previously pushed frame that carries our plugin data,
 * and reconcile() decides which to update, which to create, and which to remove, so a second push
 * only creates/removes the difference. Nodes without our plugin data (added by hand in Figma)
 * are never touched. Copies of managed nodes (Figma duplicates plugin data) are detached instead
 * of deleted, so user work is never lost.
 */
import type { NodeKind, NodeSpec } from './plan';

export interface ExistingNode {
  cdId: string;
  figmaId: string;
  kind: string;
  hash?: string;
}

export interface ReconcileResult {
  /** cdId -> existing Figma node id to update in place. */
  update: Map<string, string>;
  /** cdIds that need a new Figma node. */
  create: Set<string>;
  /** Figma node ids that are no longer in the design (or changed kind). */
  remove: string[];
  /** Duplicates of managed nodes: keep them, but strip our plugin data. */
  detach: string[];
  /** cdIds whose hash matched: properties can be skipped (children may still change). */
  unchanged: Set<string>;
}

export function flattenSpecs(root: NodeSpec): NodeSpec[] {
  const out: NodeSpec[] = [];
  const stack: NodeSpec[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    out.push(n);
    if (n.kind === 'FRAME')
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
  return out;
}

export function reconcile(
  planned: { cdId: string; kind: NodeKind; hash: string }[],
  existing: ExistingNode[],
): ReconcileResult {
  const want = new Map(planned.map((p) => [p.cdId, p]));
  const result: ReconcileResult = {
    update: new Map(),
    create: new Set(),
    remove: [],
    detach: [],
    unchanged: new Set(),
  };
  const seen = new Set<string>();
  for (const e of existing) {
    const p = want.get(e.cdId);
    if (!p) {
      result.remove.push(e.figmaId);
      continue;
    }
    if (seen.has(e.cdId)) {
      result.detach.push(e.figmaId);
      continue;
    }
    seen.add(e.cdId);
    if (e.kind !== p.kind) {
      result.remove.push(e.figmaId);
      continue;
    }
    result.update.set(e.cdId, e.figmaId);
    if (e.hash && e.hash === p.hash) result.unchanged.add(e.cdId);
  }
  for (const p of planned) if (!result.update.has(p.cdId)) result.create.add(p.cdId);
  return result;
}

/** FNV-1a 32-bit over a stable JSON serialization. */
export function hashValue(value: unknown): string {
  const s = stableJson(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
