/**
 * Removing stale managed nodes without losing hand-made layers (Story 8.2 re-push).
 * Decisions come from the pure `planRemoval`; this file only executes them against a minimal
 * node interface, so it's testable with fake nodes.
 */
import {
  planRemoval,
  PLUGIN_DATA_KEY,
  PLUGIN_KIND_KEY,
  type LiveNode,
} from '@crunch/figma-convert/plugin';

/** The parts of a Figma SceneNode/PageNode this module touches. */
export interface RemovableNode {
  id: string;
  type: string;
  readonly removed: boolean;
  readonly parent: RemovableNode | null;
  readonly children?: readonly RemovableNode[];
  absoluteTransform?: readonly (readonly number[])[];
  x?: number;
  y?: number;
  layoutMode?: string;
  layoutPositioning?: string;
  getPluginData(key: string): string;
  appendChild?(child: RemovableNode): void;
  remove(): void;
}

export function liveTree(n: RemovableNode): LiveNode {
  const managed = !!n.getPluginData(PLUGIN_DATA_KEY);
  const opaque = n.type === 'INSTANCE' || (managed && n.getPluginData(PLUGIN_KIND_KEY) === 'SVG');
  return {
    id: n.id,
    managed,
    opaque,
    children: !opaque && n.children ? n.children.map(liveTree) : [],
  };
}

const absXY = (n: RemovableNode): [number, number] | null =>
  n.absoluteTransform ? [n.absoluteTransform[0]![2]!, n.absoluteTransform[1]![2]!] : null;

/**
 * Delete `removeIds` under `host`'s `roots`, first moving every layer that isn't being removed to
 * the nearest kept ancestor (keeping its on-canvas position). Returns counts.
 */
export function removeKeepingUserLayers(
  host: RemovableNode,
  roots: RemovableNode[],
  removeIds: Iterable<string>,
): { removed: number; rescued: number } {
  const remove = new Set(removeIds);
  if (!remove.size) return { removed: 0, rescued: 0 };
  const byId = new Map<string, RemovableNode>();
  const index = (n: RemovableNode) => {
    byId.set(n.id, n);
    for (const c of n.children ?? []) index(c);
  };
  byId.set(host.id, host);
  roots.forEach(index);
  const virtualRoot: LiveNode = { id: host.id, managed: false, children: roots.map(liveTree) };
  const plan = planRemoval(virtualRoot, remove);

  let rescued = 0;
  for (const { nodeId, toParentId } of plan.rescue) {
    const node = byId.get(nodeId);
    const target = byId.get(toParentId);
    if (!node || !target?.appendChild || node.removed) continue;
    const before = absXY(node);
    target.appendChild(node);
    if (target.layoutMode && target.layoutMode !== 'NONE' && 'layoutPositioning' in node)
      node.layoutPositioning = 'ABSOLUTE';
    const origin = absXY(target);
    if (before && origin && node.x !== undefined) {
      node.x = before[0] - origin[0];
      node.y = before[1] - origin[1];
    } else if (before && target.type === 'PAGE' && node.x !== undefined) {
      node.x = before[0];
      node.y = before[1];
    }
    rescued++;
  }
  let removed = 0;
  for (const id of plan.removeRoots) {
    const n = byId.get(id);
    if (n && !n.removed) {
      n.remove();
      removed++;
    }
  }
  return { removed, rescued };
}
