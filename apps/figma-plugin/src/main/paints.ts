/**
 * Plan values -> Figma API values. Pure (no `figma` global), so they're unit-testable; binding
 * variables and loading images is done by the caller through the injected helpers.
 */
import type { EffectSpec, PaintSpec, Rgba } from '@crunch/figma-convert/plugin';

export const rgb = (c: Rgba): RGB => ({ r: c.r, g: c.g, b: c.b });

export function solidPaint(c: Rgba): SolidPaint {
  return { type: 'SOLID', color: rgb(c), opacity: c.a, visible: true, blendMode: 'NORMAL' };
}

export function gradientPaint(
  p: Extract<PaintSpec, { type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' }>,
): GradientPaint {
  return {
    type: p.type,
    gradientTransform: p.transform,
    gradientStops: p.stops.map((s) => ({ position: s.position, color: { ...s.color } })),
    visible: true,
    opacity: 1,
    blendMode: 'NORMAL',
  };
}

export function effect(e: EffectSpec): Effect {
  if (e.type === 'LAYER_BLUR') {
    return { type: 'LAYER_BLUR', blurType: 'NORMAL', radius: e.radius, visible: true };
  }
  return {
    type: e.type,
    color: { ...(e.color ?? { r: 0, g: 0, b: 0, a: 0.25 }) },
    offset: { ...(e.offset ?? { x: 0, y: 0 }) },
    radius: e.radius,
    spread: e.spread ?? 0,
    visible: true,
    blendMode: 'NORMAL',
    ...(e.type === 'DROP_SHADOW' ? { showShadowBehindNode: false } : {}),
  } as DropShadowEffect | InnerShadowEffect;
}

/** Decode a `data:image/...;base64,` URL into bytes, or null. */
export function dataUrlBytes(src: string, decode: (b64: string) => Uint8Array): Uint8Array | null {
  const m = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,([A-Za-z0-9+/=]+)$/.exec(src);
  return m ? decode(m[1]!) : null;
}
