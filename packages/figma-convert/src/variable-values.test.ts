import { describe, expect, it } from 'vitest';
import { sameVariableValue } from './variable-values';

describe('sameVariableValue', () => {
  const alias = (p: string) => ({ 'color.primary': 'VariableID:1:1' })[p];
  it('compares colors at 8-bit precision, numbers loosely, aliases by target id', () => {
    expect(sameVariableValue({ r: 1, g: 0, b: 0, a: 1 }, { r: 0.999, g: 0, b: 0 }, alias)).toBe(
      true,
    );
    expect(sameVariableValue({ r: 1, g: 0, b: 0, a: 1 }, { r: 0.9, g: 0, b: 0, a: 1 }, alias)).toBe(
      false,
    );
    expect(sameVariableValue(16, 16.001, alias)).toBe(true);
    expect(sameVariableValue(16, 24, alias)).toBe(false);
    expect(sameVariableValue('Inter', 'Inter', alias)).toBe(true);
    expect(
      sameVariableValue(
        { alias: 'color.primary' },
        { type: 'VARIABLE_ALIAS', id: 'VariableID:1:1' },
        alias,
      ),
    ).toBe(true);
    expect(sameVariableValue({ alias: 'color.primary' }, { r: 1, g: 0, b: 0 }, alias)).toBe(false);
    expect(sameVariableValue(16, undefined, alias)).toBe(false);
  });
});
