/**
 * Token usage accounting and cost estimation (Story 5.10).
 * Works on both full Messages and raw stream events, so the LLM proxy can meter streamed calls.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { CACHE_WRITE_MULTIPLIER, modelInfo } from './models';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** All cache-write tokens (5m + 1h). */
  cacheWriteTokens: number;
  /** Of cacheWriteTokens, the ones written with the 1-hour TTL (billed at 2x). */
  cacheWrite1hTokens: number;
  stopReason: string | null;
}

export const emptyUsage = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  stopReason: null,
});

type UsageLike = Partial<
  Pick<
    Anthropic.Usage,
    | 'input_tokens'
    | 'output_tokens'
    | 'cache_read_input_tokens'
    | 'cache_creation_input_tokens'
    | 'cache_creation'
  >
>;

/** Merge a usage object into running totals. Stream deltas report cumulative counts, so take the max. */
export function mergeUsage(t: UsageTotals, u: UsageLike | null | undefined): UsageTotals {
  if (!u) return t;
  return {
    ...t,
    inputTokens: Math.max(t.inputTokens, u.input_tokens ?? 0),
    outputTokens: Math.max(t.outputTokens, u.output_tokens ?? 0),
    cacheReadTokens: Math.max(t.cacheReadTokens, u.cache_read_input_tokens ?? 0),
    cacheWriteTokens: Math.max(t.cacheWriteTokens, u.cache_creation_input_tokens ?? 0),
    cacheWrite1hTokens: Math.max(
      t.cacheWrite1hTokens,
      u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    ),
  };
}

/** Fold one raw stream event into the totals. */
export function usageFromEvent(t: UsageTotals, e: Anthropic.RawMessageStreamEvent): UsageTotals {
  if (e.type === 'message_start') return mergeUsage(t, e.message.usage);
  if (e.type === 'message_delta') {
    const next = mergeUsage(t, e.usage as UsageLike);
    return { ...next, stopReason: e.delta.stop_reason ?? next.stopReason };
  }
  return t;
}

export function usageFromMessage(m: Pick<Anthropic.Message, 'usage' | 'stop_reason'>): UsageTotals {
  return { ...mergeUsage(emptyUsage(), m.usage), stopReason: m.stop_reason ?? null };
}

/**
 * Estimated cost in micro-dollars. Prices are USD per million tokens, so micro-dollars per token
 * equals the per-MTok price. Unknown models cost 0 (and are rejected by the proxy anyway).
 */
export function estimateCostMicros(model: string, u: UsageTotals): number {
  const m = modelInfo(model);
  if (!m) return 0;
  const p = m.price;
  const write1h = Math.min(u.cacheWrite1hTokens, u.cacheWriteTokens);
  const write5m = u.cacheWriteTokens - write1h;
  const micros =
    u.inputTokens * p.input +
    u.outputTokens * p.output +
    u.cacheReadTokens * p.cacheRead +
    write5m * p.input * CACHE_WRITE_MULTIPLIER['5m'] +
    write1h * p.input * CACHE_WRITE_MULTIPLIER['1h'];
  return Math.round(micros);
}

/** Share of prompt tokens served from cache: read / (uncached input + read + written). */
export function cacheHitRate(
  u: Pick<UsageTotals, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>,
) {
  const total = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  return total === 0 ? 0 : u.cacheReadTokens / total;
}
