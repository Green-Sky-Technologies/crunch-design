/**
 * Slider value → DesignDoc ops (Story 5.8). Pure and client-safe (imported by the slider tray
 * via `@crunch/agent/sliders`): moving a slider never calls the model.
 */
import {
  validateStyleValue,
  type DesignDoc,
  type DocOp,
  type Slider,
  type SliderBinding,
} from '@crunch/doc-model';

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Map a slider value through one binding's mapping. */
export function mapBinding(
  slider: Pick<Slider, 'min' | 'max'>,
  b: SliderBinding,
  value: number,
): string | number {
  const span = slider.max - slider.min;
  const t = span === 0 ? 0 : Math.min(1, Math.max(0, (value - slider.min) / span));
  if (b.map.type === 'linear') {
    const v = round(b.map.from + t * (b.map.to - b.map.from));
    const unit = b.map.unit ?? 'px';
    return unit === 'px' || unit === '' ? v : `${v}${unit}`;
  }
  const stops = [...b.map.stops].sort((a, z) => a[0] - z[0]);
  if (value <= stops[0]![0]) return stops[0]![1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [x0, y0] = stops[i]!;
    const [x1, y1] = stops[i + 1]!;
    if (value <= x1) {
      // Numbers interpolate; strings (colours, keywords) step at the lower stop.
      if (typeof y0 === 'number' && typeof y1 === 'number')
        return round(y0 + ((value - x0) / (x1 - x0 || 1)) * (y1 - y0));
      return value === x1 ? y1 : y0;
    }
  }
  return stops.at(-1)![1];
}

/**
 * Ops that set a slider to `value`: its own value plus one setStyle / setTokenOverride per
 * binding. Bindings to missing nodes or values the style allowlist rejects are skipped.
 */
export function sliderOps(doc: DesignDoc, slider: Slider, rawValue: number): DocOp[] {
  const value = Math.min(slider.max, Math.max(slider.min, rawValue));
  const ops: DocOp[] = [{ op: 'setSliderValue', id: slider.id, value }];
  for (const b of slider.bindings) {
    const mapped = mapBinding(slider, b, value);
    if ('nodeId' in b.target) {
      if (!doc.nodes[b.target.nodeId]) continue;
      if (!validateStyleValue(b.target.prop, mapped).success) continue;
      ops.push({
        op: 'setStyle',
        id: b.target.nodeId,
        breakpoint: b.target.breakpoint,
        prop: b.target.prop,
        value: mapped,
      });
    } else {
      ops.push({ op: 'setTokenOverride', path: b.target.token, value: mapped });
    }
  }
  return ops;
}

/** Snap to the slider's step. */
export const snap = (s: Pick<Slider, 'min' | 'step'>, v: number) =>
  round(s.min + Math.round((v - s.min) / s.step) * s.step);
