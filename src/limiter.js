// Wrong-password slowdown and blocking, shared across instances through the store (DESIGN §5.2).
//
// Bound: a password is evaluated only after a precheck that saw no block, no wait, fewer than
// AUTH_MAX_FAILURES failures and at most AUTH_MAX_INFLIGHT concurrent evaluations for the source.
// So wrong-password evaluations per source per window <= AUTH_MAX_FAILURES + AUTH_MAX_INFLIGHT.
// Strikes count blocks, not failures: only the failure that reaches exactly AUTH_MAX_FAILURES
// increments them, so a burst from one misconfigured client is one strike.
import { KEYS_HASH } from './keys.js';

const PREFIX = 'mr:v1:auth:';
const INFLIGHT_TTL_SECONDS = 60;
const STRIKES_TTL_SECONDS = 7 * 24 * 3600;
const MAX_BLOCK_SECONDS = 86400;

/** @param {string} source */
export function limiterKeys(source) {
  return {
    block: `${PREFIX}block:${source}`,
    wait: `${PREFIX}wait:${source}`,
    fail: `${PREFIX}fail:${source}`,
    inflight: `${PREFIX}inflight:${source}`,
    strikes: `${PREFIX}strikes:${source}`,
  };
}

/**
 * @typedef {{maxFailures: number, windowSeconds: number, blockSeconds: number, maxInflight: number,
 *   backoffBaseMs: number, backoffMaxMs: number}} Limits
 * @typedef {{allowed: true, keysHash: unknown[]}
 *   | {allowed: false, code: 'source_blocked' | 'auth_backoff' | 'auth_busy', retryAfter: number}} Precheck
 */

/**
 * @param {{store: import('./store/index.js').Store, limits: Limits, now?: () => number}} options
 */
export function createLimiter({ store, limits, now = Date.now }) {
  return {
    /**
     * One pipeline: GET block, PTTL wait, GET fail, INCR inflight, EXPIRE inflight 60, HGETALL keys.
     * The inflight slot taken here must always be released (release() or recordFailure()).
     * @param {string} source
     * @returns {Promise<Precheck>}
     */
    async precheck(source) {
      const k = limiterKeys(source);
      const [block, waitMs, fail, inflight, , keysHash] = await store.pipeline([
        ['GET', k.block],
        ['PTTL', k.wait],
        ['GET', k.fail],
        ['INCR', k.inflight],
        ['EXPIRE', k.inflight, INFLIGHT_TTL_SECONDS],
        ['HGETALL', KEYS_HASH],
      ]);
      // A release whose slot key had already expired (a request outliving the 60 s TTL) DECRs a
      // missing key to -1 without a TTL; later INCRs would then undercount concurrent requests.
      // Reset such a counter to this request alone.
      if (Number(inflight) < 1) await store.command(['SET', k.inflight, '1', 'EX', INFLIGHT_TTL_SECONDS]);
      if (block !== null) {
        // The block value is its expiry time (unix ms), so GET alone yields the remaining time.
        const until = Number(block);
        const secs = Number.isFinite(until) ? Math.ceil((until - now()) / 1000) : limits.blockSeconds;
        return { allowed: false, code: 'source_blocked', retryAfter: Math.max(1, secs) };
      }
      if (Number(waitMs) > 0) return { allowed: false, code: 'auth_backoff', retryAfter: Math.max(1, Math.ceil(Number(waitMs) / 1000)) };
      // The fail counter lives at most one window, so that is an upper bound for Retry-After.
      if (Number(fail ?? 0) >= limits.maxFailures) return { allowed: false, code: 'source_blocked', retryAfter: limits.windowSeconds };
      if (Number(inflight) > limits.maxInflight) return { allowed: false, code: 'auth_busy', retryAfter: 1 };
      return { allowed: true, keysHash: Array.isArray(keysHash) ? keysHash : [] };
    },

    /** @param {string} source */
    async release(source) {
      await store.command(['DECR', limiterKeys(source).inflight]);
    },

    /**
     * Wrong password: count it, release the slot, then set backoff and (at the limit) the block.
     * @param {string} source
     * @returns {Promise<{failures: number, waitMs: number, blockSeconds: number}>}
     */
    async recordFailure(source) {
      const k = limiterKeys(source);
      // SET NX starts the fixed window on the first failure and INCR keeps that TTL, so this needs
      // only Redis >= 2.6.12 commands (no Redis 7 `EXPIRE … NX`).
      const [, failures] = await store.multi([
        ['SET', k.fail, '0', 'EX', limits.windowSeconds, 'NX'],
        ['INCR', k.fail],
        ['DECR', k.inflight],
      ]);
      const f = Number(failures);
      // Each atomic INCR returns a distinct f, so exactly one request per window makes the
      // transition to blocked, even in a concurrent burst. Later ones (f > max) only get 401:
      // precheck already refuses the source on `fail >= max` and on the block key.
      const blocks = f === limits.maxFailures;
      const followUp = [];
      let waitMs = 0;
      let blockSeconds = 0;
      if (f >= 2) {
        waitMs = Math.min(limits.backoffBaseMs * 2 ** (f - 2), limits.backoffMaxMs);
        followUp.push(['SET', k.wait, '1', 'PX', waitMs]);
      }
      if (blocks) followUp.push(['INCR', k.strikes], ['EXPIRE', k.strikes, STRIKES_TTL_SECONDS]);
      if (followUp.length) {
        const results = await store.pipeline(followUp);
        if (blocks) {
          const strikes = Number(results[results.length - 2]);
          blockSeconds = Math.min(limits.blockSeconds * 2 ** Math.max(strikes - 1, 0), MAX_BLOCK_SECONDS);
          await store.command(['SET', k.block, String(now() + blockSeconds * 1000), 'EX', blockSeconds]);
        }
      }
      return { failures: f, waitMs, blockSeconds };
    },
  };
}
