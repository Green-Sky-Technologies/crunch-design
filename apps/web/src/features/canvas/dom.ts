'use client';

/**
 * DOM access for the canvas: hit-testing through frame shadow roots and measuring node rects.
 * Rendered nodes carry `data-cd-id` (instance parts also carry `data-cd-part` but share their
 * instance's id, so an instance is always one selectable node).
 */
import type { Camera, Rect } from '@crunch/canvas';

export interface Hit {
  frameId: string;
  nodeId: string;
  el: HTMLElement;
}

/** Deepest annotated node on an event's path (works across open shadow roots). */
export function hitFromEvent(e: Event): Hit | null {
  let el: HTMLElement | null = null;
  for (const t of e.composedPath()) {
    const h = t as HTMLElement;
    if (!h.dataset) continue;
    if (!el && h.dataset.cdId) el = h;
    if (h.dataset.cdFrameHost)
      return el ? { frameId: h.dataset.cdFrameHost, nodeId: el.dataset.cdId!, el } : null;
  }
  return null;
}

/** Deepest annotated node under a client point, descending into shadow roots. */
export function hitFromPoint(x: number, y: number, exclude?: (el: Element) => boolean): Hit | null {
  let el = document.elementFromPoint(x, y) as HTMLElement | null;
  let host: HTMLElement | null = null;
  while (el?.shadowRoot) {
    host = el;
    const inner = (el.shadowRoot.elementsFromPoint?.(x, y) ?? []).find(
      (c) => c !== el && !(exclude?.(c) ?? false),
    ) as HTMLElement | undefined;
    if (!inner) break;
    el = inner;
  }
  host ??= el?.closest<HTMLElement>('[data-cd-frame-host]') ?? null;
  const node = el?.closest<HTMLElement>('[data-cd-id]');
  const frameId = host?.dataset.cdFrameHost;
  if (!node || !frameId) return null;
  return { frameId, nodeId: node.dataset.cdId!, el: node };
}

export function frameHost(scope: ParentNode, frameId: string): HTMLElement | null {
  return scope.querySelector<HTMLElement>(`[data-cd-frame-host="${frameId}"]`);
}

/** The element rendering a node (for instances, the instance root part comes first). */
export function nodeElement(
  scope: ParentNode,
  frameId: string,
  nodeId: string,
): HTMLElement | null {
  return (
    frameHost(scope, frameId)?.shadowRoot?.querySelector<HTMLElement>(`[data-cd-id="${nodeId}"]`) ??
    null
  );
}

/** Element rect relative to the canvas viewport (overlay coordinates). */
export function screenRect(viewport: Element, el: Element): Rect {
  const v = viewport.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: r.left - v.left, y: r.top - v.top, width: r.width, height: r.height };
}

/** Element rect in world coordinates (independent of the camera). */
export function worldRect(viewport: Element, el: Element, c: Camera): Rect {
  const s = screenRect(viewport, el);
  return {
    x: (s.x - c.x) / c.z,
    y: (s.y - c.y) / c.z,
    width: s.width / c.z,
    height: s.height / c.z,
  };
}

/** Layout facts about an element's own flow (for drop indicators and sizing hints). */
export function flowOf(el: Element): {
  display: string;
  direction: 'row' | 'column';
  grid: boolean;
} {
  const cs = getComputedStyle(el);
  const display = cs.display;
  const flex = display === 'flex' || display === 'inline-flex';
  const grid = display === 'grid' || display === 'inline-grid';
  const direction = flex && !cs.flexDirection.startsWith('column') ? 'row' : 'column';
  return { display, direction: grid ? 'row' : direction, grid };
}

/**
 * The node under a client point inside a canvas viewport, looking through overlay layers to the
 * frames below (for comment mode and other overlays). With `doc`, locked nodes resolve to their
 * nearest selectable ancestor, as a canvas click would.
 */
export function nodeAtPoint(
  viewport: Element,
  clientX: number,
  clientY: number,
  doc?: { nodes: Record<string, { id: string; parentId: string | null; locked?: boolean }> },
): { frameId: string; nodeId: string } | null {
  const v = viewport.getBoundingClientRect();
  if (clientX < v.left || clientX > v.right || clientY < v.top || clientY > v.bottom) return null;
  const stack = document.elementsFromPoint?.(clientX, clientY) ?? [];
  const host = stack.find(
    (e): e is HTMLElement =>
      (e as HTMLElement).dataset?.cdFrameHost !== undefined && viewport.contains(e),
  );
  if (!host?.shadowRoot) return null;
  const inner = (host.shadowRoot.elementsFromPoint?.(clientX, clientY) ?? [])
    .map((c) => c.closest<HTMLElement>('[data-cd-id]'))
    .find((c): c is HTMLElement => !!c);
  if (!inner) return null;
  let nodeId: string | null = inner.dataset.cdId!;
  if (doc) {
    let n = doc.nodes[nodeId];
    while (n?.locked && n.parentId) n = doc.nodes[n.parentId];
    nodeId = n && !n.locked ? n.id : null;
  }
  return nodeId ? { frameId: host.dataset.cdFrameHost!, nodeId } : null;
}
