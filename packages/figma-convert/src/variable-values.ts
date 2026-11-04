/**
 * Compare a planned variable value with what Figma holds. Dependency-free (used by the plugin to
 * decide whether a design push would overwrite a Figma variable that differs; Story 8.2/8.4).
 */
import type { Rgba, VariableValueSpec } from './plan';

export type FigmaVariableValue =
  | boolean
  | number
  | string
  | { r: number; g: number; b: number; a?: number }
  | { type: 'VARIABLE_ALIAS'; id: string }
  | Record<string, unknown>;

const q = (n: number) => Math.round(n * 255);

/**
 * True when `actual` (from Figma) already equals `planned`. `aliasId` resolves a token path to the
 * Figma variable id it maps to (undefined when unknown).
 */
export function sameVariableValue(
  planned: VariableValueSpec,
  actual: FigmaVariableValue | undefined,
  aliasId: (path: string) => string | undefined,
): boolean {
  if (actual === undefined) return false;
  if (typeof planned === 'object' && 'alias' in planned) {
    return (
      typeof actual === 'object' &&
      (actual as { type?: string }).type === 'VARIABLE_ALIAS' &&
      (actual as { id: string }).id === aliasId(planned.alias)
    );
  }
  if (typeof planned === 'object') {
    const p = planned as Rgba;
    if (typeof actual !== 'object' || !('r' in actual)) return false;
    const a = actual as { r: number; g: number; b: number; a?: number };
    return q(p.r) === q(a.r) && q(p.g) === q(a.g) && q(p.b) === q(a.b) && q(p.a) === q(a.a ?? 1);
  }
  if (typeof planned === 'number')
    return typeof actual === 'number' && Math.abs(planned - actual) < 0.01;
  return planned === actual;
}
