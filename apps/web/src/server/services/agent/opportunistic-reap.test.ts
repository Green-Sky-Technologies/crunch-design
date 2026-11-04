import { beforeEach, describe, expect, it, vi } from 'vitest';
import { maybeReap, REAP_INTERVAL_MS, resetReapThrottle } from './opportunistic-reap';

beforeEach(resetReapThrottle);

describe('maybeReap', () => {
  it('runs at most once per interval per instance', () => {
    const reap = vi.fn(async () => {});
    const t0 = 1_000_000;
    expect(maybeReap(reap, t0)).toBe(true);
    expect(maybeReap(reap, t0 + 1_000)).toBe(false);
    expect(maybeReap(reap, t0 + REAP_INTERVAL_MS)).toBe(true);
    expect(reap).toHaveBeenCalledTimes(2);
  });

  it('swallows reaper failures (a status read never fails because of it)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(maybeReap(() => Promise.reject(new Error('boom')), REAP_INTERVAL_MS)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
