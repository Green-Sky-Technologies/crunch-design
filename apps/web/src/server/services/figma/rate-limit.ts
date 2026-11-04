/**
 * Fixed-window rate limiter for plugin routes (Story 8.1).
 *
 * In-memory and per server instance: good enough to stop a runaway plugin loop or token
 * guessing from one client, but not a global limit across instances. Story 9.3 can swap
 * the store for a shared one (the interface is just `hit(key)`).
 */
export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  /** Seconds until the window resets. */
  retryAfter: number;
}

export class RateLimitedError extends Error {
  override name = 'RateLimitedError';
  constructor(public readonly retryAfter: number) {
    super('Too many requests; slow down');
  }
}

export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    /** Hard cap on tracked keys, so a flood of distinct keys can't grow memory without bound. */
    private readonly maxKeys = 10_000,
  ) {}

  get size() {
    return this.windows.size;
  }

  hit(key: string): RateLimitResult {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      if (w) this.windows.delete(key);
      if (this.windows.size >= this.maxKeys) this.sweep(t);
      // Still full of live windows: evict the oldest (Map keeps insertion order).
      while (this.windows.size >= this.maxKeys) {
        const oldest = this.windows.keys().next().value;
        if (oldest === undefined) break;
        this.windows.delete(oldest);
      }
      w = { start: t, count: 0 };
      this.windows.set(key, w);
    }
    w.count++;
    const retryAfter = Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000));
    return { ok: w.count <= this.limit, remaining: Math.max(0, this.limit - w.count), retryAfter };
  }

  /** Throws RateLimitedError when over the limit. */
  check(key: string): void {
    const r = this.hit(key);
    if (!r.ok) throw new RateLimitedError(r.retryAfter);
  }

  private sweep(t: number) {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}
