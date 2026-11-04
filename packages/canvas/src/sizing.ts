/**
 * Auto-layout sizing (Story 3.5): fixed / fill / hug, like Figma. The renderer maps `hug` to
 * fit-content and `fill` to flex-grow (main axis), align-self:stretch (cross axis) or 100%
 * (block parents). `sizingToTailwind` gives the equivalent classes for code export (7.3), so
 * hug/fill survive export with the same behaviour.
 */
import { isTokenRef, tokenCssVar } from '@crunch/doc-model';
import type { Rect } from './geometry';

export type SizingMode = 'fixed' | 'fill' | 'hug' | 'auto';

export function sizingMode(value: unknown): SizingMode {
  if (value === 'fill') return 'fill';
  if (value === 'hug') return 'hug';
  if (value === undefined || value === null || value === 'auto') return 'auto';
  return 'fixed';
}

export interface ParentFlow {
  display: string;
  direction: 'row' | 'column';
}

const isFlex = (p: ParentFlow) => p.display === 'flex' || p.display === 'inline-flex';

/** Tailwind classes equivalent to a width/height value under a given parent layout. */
export function sizingToTailwind(
  axis: 'width' | 'height',
  value: unknown,
  parent: ParentFlow,
): string {
  const w = axis === 'width' ? 'w' : 'h';
  const min = axis === 'width' ? 'min-w-0' : 'min-h-0';
  if (value === undefined || value === null || value === 'auto') return `${w}-auto`;
  if (value === 'hug') return `${w}-fit`;
  if (value === 'fill') {
    if (!isFlex(parent)) return `${w}-full`;
    const main = parent.direction === 'row' ? 'width' : 'height';
    return axis === main ? `flex-1 basis-0 ${min}` : 'self-stretch';
  }
  if (isTokenRef(value)) return `${w}-[var(${tokenCssVar(value.token)})]`;
  if (typeof value === 'number') return `${w}-[${value}px]`;
  return `${w}-[${String(value)}]`;
}

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const ALL_HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
/** Flow nodes are positioned by layout, so only the far edges resize them. */
export const FLOW_HANDLES: Handle[] = ['e', 'se', 's'];

export const MIN_SIZE = 1;

/** New rect after dragging a handle by (dx, dy) world px. Shift keeps the aspect ratio. */
export function resizeRect(
  start: Rect,
  handle: Handle,
  dx: number,
  dy: number,
  keepAspect = false,
): Rect {
  let { x, y, width, height } = start;
  if (handle.includes('e')) width = start.width + dx;
  if (handle.includes('w')) {
    width = start.width - dx;
    x = start.x + dx;
  }
  if (handle.includes('s')) height = start.height + dy;
  if (handle.includes('n')) {
    height = start.height - dy;
    y = start.y + dy;
  }
  if (keepAspect && start.width > 0 && start.height > 0) {
    const ratio = start.width / start.height;
    const horizontal = handle === 'e' || handle === 'w';
    const vertical = handle === 'n' || handle === 's';
    if (horizontal || (!vertical && Math.abs(dx) >= Math.abs(dy))) height = width / ratio;
    else width = height * ratio;
    if (handle.includes('n')) y = start.y + start.height - height;
    if (handle.includes('w')) x = start.x + start.width - width;
  }
  if (width < MIN_SIZE) {
    if (handle.includes('w')) x -= MIN_SIZE - width;
    width = MIN_SIZE;
  }
  if (height < MIN_SIZE) {
    if (handle.includes('n')) y -= MIN_SIZE - height;
    height = MIN_SIZE;
  }
  return { x, y, width, height };
}
