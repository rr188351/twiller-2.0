/**
 * A tiny in-memory, per-key rate limiter.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Twiller backend already guards password recovery with an inline Map
 * (`isRequestRateLimited` in index.js). That guard is deliberately left exactly
 * as it is - this module is the same idea factored into a reusable factory, so
 * a NEW public endpoint can get its own independent budget without widening or
 * sharing the recovery limit.
 *
 * SCOPE: one process, one instance, one budget. It stops a single client from
 * hammering an endpoint; it is not a distributed limiter, and on a multi-instance
 * host each instance would hold its own counters.
 */

/**
 * Creates an independent per-key sliding-window limiter.
 *
 * @param {{max: number, windowMs: number}} options
 *   `max`      attempts allowed per key inside the window
 *   `windowMs` length of that window in milliseconds
 * @returns {{check: (key: unknown) => {allowed: boolean, remaining: number, retryAfterSeconds: number}, reset: () => void}}
 */
export function createIpRateLimiter({ max, windowMs }) {
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 1;
  const window = Number.isFinite(windowMs) && windowMs > 0 ? Math.floor(windowMs) : 60_000;

  /** @type {Map<string, number[]>} */
  const buckets = new Map();

  // Nothing outside this module should be able to leave one map entry per IP
  // behind for ever, so stale buckets are swept periodically (at most once per
  // window, and never on every request).
  const sweepIntervalMs = Math.max(window, 60_000);
  let lastSweep = Date.now();

  function sweep(now) {
    if (now - lastSweep < sweepIntervalMs) return;
    lastSweep = now;
    for (const [key, times] of buckets) {
      const fresh = times.filter((time) => now - time < window);
      if (fresh.length) buckets.set(key, fresh);
      else buckets.delete(key);
    }
  }

  return {
    /**
     * Records one attempt and reports whether it may proceed.
     *
     * @param {unknown} key usually the client IP
     */
    check(key) {
      const now = Date.now();
      sweep(now);

      const id = String(key || "unknown");
      const recent = (buckets.get(id) || []).filter((time) => now - time < window);

      if (recent.length >= limit) {
        buckets.set(id, recent);
        const oldest = recent[0];
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((window - (now - oldest)) / 1000)
          ),
        };
      }

      recent.push(now);
      buckets.set(id, recent);

      return {
        allowed: true,
        remaining: Math.max(0, limit - recent.length),
        retryAfterSeconds: 0,
      };
    },

    /** Forgets every counter (used by tests). */
    reset() {
      buckets.clear();
    },
  };
}

export default { createIpRateLimiter };
