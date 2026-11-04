import { describe, expect, it } from 'vitest';
import { normalizeSslMode } from './index';

describe('normalizeSslMode', () => {
  it('pins strict TLS verification and leaves other URLs alone', () => {
    expect(normalizeSslMode('postgres://u:p@h/db?sslmode=require')).toBe(
      'postgres://u:p@h/db?sslmode=verify-full',
    );
    expect(normalizeSslMode('postgres://u:p@h/db?x=1&sslmode=prefer&y=2')).toBe(
      'postgres://u:p@h/db?x=1&sslmode=verify-full&y=2',
    );
    expect(normalizeSslMode('postgres://u:p@localhost:5433/db')).toBe(
      'postgres://u:p@localhost:5433/db',
    );
    expect(normalizeSslMode('postgres://h/db?sslmode=disable')).toBe(
      'postgres://h/db?sslmode=disable',
    );
  });
});
