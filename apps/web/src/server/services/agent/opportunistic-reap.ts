/**
 * Run the job reaper from ordinary traffic as well as from cron. Vercel's Hobby plan only allows
 * daily cron jobs, so a free-tier deployment would otherwise start lost jobs and clean up stuck
 * sandboxes once a day. While anyone is watching a job, this keeps it to about a minute.
 *
 * Throttled per server instance; concurrent runs across instances are safe because every job
 * transition is a compare-and-set on the job's status.
 */
export const REAP_INTERVAL_MS = 60_000;

let lastRun = 0;

export function maybeReap(reap: () => Promise<unknown>, now = Date.now()): boolean {
  if (now - lastRun < REAP_INTERVAL_MS) return false;
  lastRun = now;
  void reap().catch((e: unknown) => {
    console.warn('[jobs] opportunistic reap failed:', e instanceof Error ? e.message : e);
  });
  return true;
}

/** For tests. */
export function resetReapThrottle() {
  lastRun = 0;
}
