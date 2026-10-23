// Wrong-password slowdown and blocking, shared across instances through the store (DESIGN §5.2).
//
// Bound: a password is evaluated only after a precheck that saw no block, no wait, fewer than
// AUTH_MAX_FAILURES failures and at most AUTH_MAX_INFLIGHT concurrent evaluations for the source.
// So wrong-password evaluations per source per window <= AUTH_MAX_FAILURES + AUTH_MAX_INFLIGHT.
// Strikes count blocks, not failures: only the failure that reaches exactly AUTH_MAX_FAILURES
// increments them, so a burst from one misconfigured client is one strike.
const MAX_BLOCK_SECONDS = 86400;

/**
 * @typedef {{maxFailures: number, windowSeconds: number, blockSeconds: number, maxInflight: number,
 *   backoffBaseMs: number, backoffMaxMs: number}} Limits
 * @typedef {{allowed: true, keys: Record<string, string>}
 *   | {allowed: false, code: 'source_blocked' | 'auth_backoff' | 'auth_busy', retryAfter: number}} Precheck
 */

/**
 * The store keeps the per-source fields and their end times (failure window, wait, block,
 * strikes for 7 days, inflight for 60 s) and implements the atomic steps; the policy is here.
 * @param {{store: import('./store/index.js').Store, limits: Limits, now?: () => number}} options
 */
export function createLimiter({ store, limits, now = Date.now }) {
  return {
    /**
     * One store round trip: take an inflight slot and read the active block, wait and failure
     * count, plus the stored provider keys. The slot must always be released (release() or
     * recordFailure()).
     * @param {string} source
     * @returns {Promise<Precheck>}
     */
    async precheck(source) {
      const t = now();
      const r = await store.authPrecheck(source, t);
      if (r.blockUntilMs !== null) return { allowed: false, code: 'source_blocked', retryAfter: Math.max(1, Math.ceil((r.blockUntilMs - t) / 1000)) };
      if (r.waitUntilMs !== null) return { allowed: false, code: 'auth_backoff', retryAfter: Math.max(1, Math.ceil((r.waitUntilMs - t) / 1000)) };
      // The failure window lasts at most windowSeconds, so that is an upper bound for Retry-After.
      if (r.failures >= limits.maxFailures) return { allowed: false, code: 'source_blocked', retryAfter: limits.windowSeconds };
      if (r.inflight > limits.maxInflight) return { allowed: false, code: 'auth_busy', retryAfter: 1 };
      return { allowed: true, keys: r.keys };
    },

    /** @param {string} source */
    async release(source) {
      await store.authRelease(source, now());
    },

    /**
     * Wrong password: count it and release the slot (one atomic step), then set the backoff and,
     * at the limit, the block. Neither ever shortens one already set.
     * @param {string} source
     * @returns {Promise<{failures: number, waitMs: number, blockSeconds: number}>}
     */
    async recordFailure(source) {
      const t = now();
      const { failures: f, strikes } = await store.authFailure(source, t, { windowMs: limits.windowSeconds * 1000, maxFailures: limits.maxFailures });
      // Each failure gets a distinct count, so exactly one request per window reaches
      // maxFailures and adds a strike, even in a concurrent burst. Later ones (f > max) only get
      // 401: precheck already refuses the source on `failures >= max` and on the block.
      const waitMs = f >= 2 ? Math.min(limits.backoffBaseMs * 2 ** (f - 2), limits.backoffMaxMs) : 0;
      const blockSeconds = strikes === null ? 0 : Math.min(limits.blockSeconds * 2 ** Math.max(strikes - 1, 0), MAX_BLOCK_SECONDS);
      if (waitMs > 0 || blockSeconds > 0) {
        await store.authPenalty(source, t, { waitUntilMs: waitMs > 0 ? t + waitMs : null, blockUntilMs: blockSeconds > 0 ? t + blockSeconds * 1000 : null });
      }
      return { failures: f, waitMs, blockSeconds };
    },
  };
}
