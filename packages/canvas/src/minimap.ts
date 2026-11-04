/** Minimap projection: fits all frames plus the visible area into a small box. */
import { union, type Point, type Rect } from './geometry';

export interface MinimapLayout {
  /** World -> minimap scale. */
  scale: number;
  /** World rect shown by the minimap (top-left maps to the minimap origin after centering). */
  world: Rect;
  offset: Point;
  frames: Rect[];
  viewport: Rect;
}

export function minimapLayout(
  frames: readonly Rect[],
  viewport: Rect,
  size: { width: number; height: number },
  padding = 6,
): MinimapLayout {
  const world = union([...frames, viewport]) ?? viewport;
  const scale = Math.min(
    (size.width - padding * 2) / Math.max(1, world.width),
    (size.height - padding * 2) / Math.max(1, world.height),
  );
  const offset = {
    x: (size.width - world.width * scale) / 2 - world.x * scale,
    y: (size.height - world.height * scale) / 2 - world.y * scale,
  };
  const project = (r: Rect): Rect => ({
    x: r.x * scale + offset.x,
    y: r.y * scale + offset.y,
    width: r.width * scale,
    height: r.height * scale,
  });
  return { scale, world, offset, frames: frames.map(project), viewport: project(viewport) };
}

/** Minimap point -> world point. */
export const minimapToWorld = (m: MinimapLayout, p: Point): Point => ({
  x: (p.x - m.offset.x) / m.scale,
  y: (p.y - m.offset.y) / m.scale,
});
