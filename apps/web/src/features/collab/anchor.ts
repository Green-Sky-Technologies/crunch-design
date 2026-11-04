/**
 * Pure comment-anchor helpers shared by the server (orphan detection) and the client (pins,
 * composer). No framework or server imports.
 */
import type { OverlayRect } from '@crunch/contracts/canvas-overlay';
import type { DesignDoc, Node } from '@crunch/doc-model';

/** The frame whose tree currently contains `nodeId`, or null if the node is gone or detached. */
export function frameOfNode(doc: DesignDoc, nodeId: string): string | null {
  let cur: Node | undefined = doc.nodes[nodeId];
  let root: Node | undefined;
  for (let i = 0; cur && i < 10_000; i++) {
    root = cur;
    cur = cur.parentId ? doc.nodes[cur.parentId] : undefined;
  }
  if (!root || cur) return null; // missing node, or the depth guard tripped
  return doc.frames.find((f) => f.rootNodeId === root.id)?.id ?? null;
}

/** Where a node-anchored pin sits: the node's top-right corner plus an offset (overlay px). */
export function pinAnchorPoint(r: OverlayRect, offset = { x: 0, y: 0 }): { x: number; y: number } {
  return { x: r.x + r.width + offset.x, y: r.y + offset.y };
}
