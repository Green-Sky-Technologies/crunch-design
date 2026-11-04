import { describe, expect, it } from 'vitest';
import {
  baseModelId,
  cacheHitRate,
  emptyUsage,
  encodeSse,
  estimateCostMicros,
  formatRelativeCost,
  isModelAllowed,
  ModelNotAllowedError,
  parseSse,
  relativeCost,
  resolveModel,
  stableStringify,
  usageFromEvent,
  type WorkspaceModelSettings,
} from './index';
import { MODEL_TIERS } from '@crunch/providers';

describe('cost estimation', () => {
  it('prices input, output, cache reads and both write TTLs', () => {
    const u = {
      ...emptyUsage(),
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 2_000_000,
      cacheWrite1hTokens: 1_000_000,
    };
    // Opus 5.5: $4 in, $20 out, $0.20 read, 5m write 1.25x = $5, 1h write 2x = $8.
    expect(estimateCostMicros('claude-opus-5-5', u)).toBe((4 + 20 + 0.2 + 5 + 8) * 1e6);
    expect(estimateCostMicros('anthropic.claude-opus-5-5', u)).toBe(37.2e6);
    expect(estimateCostMicros('unknown-model', u)).toBe(0);
  });

  it('accumulates usage from stream events', () => {
    let u = emptyUsage();
    u = usageFromEvent(u, {
      type: 'message_start',
      message: {
        usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 90 },
      },
    } as never);
    u = usageFromEvent(u, {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 55 },
    } as never);
    expect(u).toMatchObject({
      inputTokens: 10,
      outputTokens: 55,
      cacheReadTokens: 90,
      stopReason: 'tool_use',
    });
    expect(cacheHitRate(u)).toBe(0.9);
    expect(cacheHitRate(emptyUsage())).toBe(0);
  });
});

describe('model resolution', () => {
  const open: WorkspaceModelSettings = { modelDefaults: {}, allowedModels: null };

  it('defaults by task tier from MODEL_TIERS', () => {
    expect(resolveModel(open, 'interactive')).toBe(MODEL_TIERS.interactive);
    expect(resolveModel(open, 'generation')).toBe(MODEL_TIERS.generation);
    expect(resolveModel(open, 'codegen')).toBe(MODEL_TIERS.generation);
    expect(resolveModel(open, 'utility')).toBe(MODEL_TIERS.utility);
  });

  it('honours admin defaults, the allowed list and per-prompt overrides', () => {
    const s: WorkspaceModelSettings = {
      modelDefaults: { interactive: 'claude-opus-5-5' },
      allowedModels: ['claude-opus-5-5', 'claude-haiku-5-5'],
    };
    expect(resolveModel(s, 'interactive')).toBe('claude-opus-5-5');
    expect(resolveModel(s, 'interactive', 'claude-haiku-5-5')).toBe('claude-haiku-5-5');
    expect(() => resolveModel(s, 'interactive', 'claude-sonnet-5-5')).toThrow(ModelNotAllowedError);
    // Generation default (opus) allowed; utility default (haiku) allowed.
    expect(resolveModel({ ...s, modelDefaults: {} }, 'interactive')).toBe('claude-haiku-5-5');
    expect(isModelAllowed(s, 'gpt-4')).toBe(false);
  });

  it('reports relative cost against the interactive tier', () => {
    expect(relativeCost(MODEL_TIERS.interactive)).toBe(1);
    expect(relativeCost('claude-opus-5-5')).toBe(2);
    expect(formatRelativeCost('claude-haiku-5-5')).toBe('0.05×');
    expect(formatRelativeCost('claude-opus-5-5')).toBe('2×');
    expect(baseModelId('us.anthropic.claude-opus-5-5')).toBe('claude-opus-5-5');
  });
});

describe('SSE and stable serialization', () => {
  it('round-trips SSE frames', () => {
    const text =
      encodeSse({ id: 3, event: 'progress', data: { a: 1 } }) +
      ': keepalive\n\n' +
      encodeSse({ data: 'two\nlines' });
    expect(parseSse(text)).toEqual([
      { id: '3', event: 'progress', data: '{"a":1}' },
      { id: undefined, event: undefined, data: 'two\nlines' },
    ]);
  });

  it('sorts keys recursively and drops undefined', () => {
    expect(stableStringify({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[{"y":2,"z":1}]},"b":1}',
    );
  });
});
