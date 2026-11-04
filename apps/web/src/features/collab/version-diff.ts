/** Structural diff of two DesignDocs, per frame, for the side-by-side version compare (Story 6.2). */
import type { DesignDoc, Node } from '@crunch/doc-model';

export interface FrameDiff {
  frameId: string;
  name: string;
  status: 'added' | 'removed' | 'changed' | 'unchanged';
  added: string[];
  removed: string[];
  changed: string[];
}

function subtreeIds(doc: DesignDoc, rootId: string): string[] {
  const out: string[] = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    const n = doc.nodes[id];
    if (!n) continue;
    out.push(id);
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
  return out;
}

/** Stable JSON (sorted keys) so key order never counts as a change. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

const same = (a: Node, b: Node) => stable(a) === stable(b);

/** Compare `before` → `after`. Frames are matched by id. */
export function diffDocs(before: DesignDoc, after: DesignDoc): FrameDiff[] {
  const out: FrameDiff[] = [];
  const afterFrames = new Map(after.frames.map((f) => [f.id, f]));
  const beforeFrames = new Map(before.frames.map((f) => [f.id, f]));
  const tokensChanged = stable(before.tokenOverrides) !== stable(after.tokenOverrides);

  for (const f of after.frames) {
    const old = beforeFrames.get(f.id);
    const ids = subtreeIds(after, f.rootNodeId);
    if (!old) {
      out.push({
        frameId: f.id,
        name: f.name,
        status: 'added',
        added: ids,
        removed: [],
        changed: [],
      });
      continue;
    }
    const oldIds = subtreeIds(before, old.rootNodeId);
    const oldSet = new Set(oldIds);
    const newSet = new Set(ids);
    const added = ids.filter((id) => !oldSet.has(id));
    const removed = oldIds.filter((id) => !newSet.has(id));
    const changed = ids.filter(
      (id) => oldSet.has(id) && !same(before.nodes[id]!, after.nodes[id]!),
    );
    const frameChanged = stable({ ...old, canvas: 0 }) !== stable({ ...f, canvas: 0 });
    const status =
      added.length || removed.length || changed.length || frameChanged || tokensChanged
        ? 'changed'
        : 'unchanged';
    out.push({ frameId: f.id, name: f.name, status, added, removed, changed });
  }
  for (const f of before.frames) {
    if (afterFrames.has(f.id)) continue;
    out.push({
      frameId: f.id,
      name: f.name,
      status: 'removed',
      added: [],
      removed: subtreeIds(before, f.rootNodeId),
      changed: [],
    });
  }
  return out;
}
