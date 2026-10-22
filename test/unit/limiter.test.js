import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyPassword } from '../../src/auth.js';
import { createLimiter } from '../../src/limiter.js';
import { STORE_METHODS, failClosed } from '../../src/store/index.js';
import { createMemoryStore } from '../../src/store/memory.js';
import { WRONG_PASSWORD, bearer, fakeClock } from '../helpers/fixtures.js';
import { makeHarness } from '../helpers/harness.js';

const LIMITS = { maxFailures: 10, windowSeconds: 3600, blockSeconds: 60, maxInflight: 32, backoffBaseMs: 100, backoffMaxMs: 400 };
const S = 'a'.repeat(32);

/** @param {Partial<typeof LIMITS>} [limits] */
function setup(limits = {}) {
  const clock = fakeClock();
  const raw = createMemoryStore();
  const limiter = createLimiter({ store: failClosed(raw), limits: { ...LIMITS, ...limits }, now: clock.now });
  /** The source's auth row with its end times as remaining milliseconds (0 when passed). */
  const row = () => {
    const r = raw.dump().auth_sources.find((x) => x.source === S);
    if (!r) return null;
    const left = (/** @type {number} */ until) => Math.max(until - clock.now(), 0);
    return {
      failures: r.failures,
      strikes: r.strikes,
      inflight: r.inflight,
      fail_ms: left(r.failures_until_ms),
      wait_ms: left(r.wait_until_ms),
      block_ms: left(r.block_until_ms),
      strikes_ms: left(r.strikes_until_ms),
      inflight_ms: left(r.inflight_until_ms),
    };
  };
  return { clock, raw, limiter, row };
}

/** @param {ReturnType<typeof createLimiter>} limiter */
async function wrong(limiter) {
  const pre = await limiter.precheck(S);
  assert.equal(pre.allowed, true, JSON.stringify(pre));
  return limiter.recordFailure(S);
}

test('backoff: wait = min(base * 2^(f-2), max) from the second failure, enforced at precheck', async () => {
  const { clock, limiter, row } = setup();
  assert.deepEqual(await wrong(limiter), { failures: 1, waitMs: 0, blockSeconds: 0 });
  const f2 = await wrong(limiter);
  assert.equal(f2.waitMs, 100);
  assert.equal(row()?.wait_ms, 100);
  const blocked = await limiter.precheck(S);
  assert.deepEqual(blocked, { allowed: false, code: 'auth_backoff', retryAfter: 1 });
  await limiter.release(S);
  clock.advance(99);
  assert.equal((await limiter.precheck(S)).allowed, false);
  await limiter.release(S);
  clock.advance(1);
  assert.equal((await wrong(limiter)).waitMs, 200);
  clock.advance(200);
  assert.equal((await wrong(limiter)).waitMs, 400);
  clock.advance(400);
  assert.equal((await wrong(limiter)).waitMs, 400, 'capped at AUTH_BACKOFF_MAX_MS');
  assert.equal(row()?.inflight, 0, 'every precheck slot was released');
});

test('block after AUTH_MAX_FAILURES; Retry-After is the remaining block time', async () => {
  const { clock, limiter, row } = setup({ maxFailures: 3 });
  await wrong(limiter);
  clock.advance(100);
  await wrong(limiter);
  clock.advance(200);
  const third = await wrong(limiter);
  assert.deepEqual(third, { failures: 3, waitMs: 200, blockSeconds: 60 });
  assert.equal(row()?.block_ms, 60_000);
  clock.advance(5000);
  assert.deepEqual(await limiter.precheck(S), { allowed: false, code: 'source_blocked', retryAfter: 55 });
  await limiter.release(S);
  clock.advance(55_000); // the block is over; the failure window (3600 s) is not
  assert.equal(row()?.block_ms, 0);
  assert.deepEqual(await limiter.precheck(S), { allowed: false, code: 'source_blocked', retryAfter: 3600 }, 'failures >= max alone still blocks');
});

test('block expiry and strikes escalation (block * 2^(strikes-1), capped at 86400 s)', async () => {
  const { clock, limiter, row } = setup({ maxFailures: 2, windowSeconds: 10, blockSeconds: 20 });
  const episode = async () => {
    await wrong(limiter);
    const last = await wrong(limiter);
    return last.blockSeconds;
  };
  assert.equal(await episode(), 20);
  clock.advance(19999);
  assert.equal((await limiter.precheck(S)).allowed, false);
  await limiter.release(S);
  clock.advance(1);
  const pre = await limiter.precheck(S);
  assert.equal(pre.allowed, true, 'block and failure window both expired');
  await limiter.release(S);
  assert.equal(await episode(), 40);
  assert.equal(row()?.strikes_ms, 7 * 24 * 3600 * 1000);
  clock.advance(40000);
  assert.equal(await episode(), 80);

  const capped = setup({ maxFailures: 1, windowSeconds: 1, blockSeconds: 50000 });
  assert.equal((await wrong(capped.limiter)).blockSeconds, 50000);
  capped.clock.advance(50000 * 1000);
  assert.equal((await wrong(capped.limiter)).blockSeconds, 86400);
});

test('burst past AUTH_MAX_FAILURES is one strike and one block of AUTH_BLOCK_SECONDS; the next block doubles', async () => {
  const { clock, limiter, row } = setup({ maxFailures: 3, windowSeconds: 10, blockSeconds: 20 });
  const burst = async () => {
    for (let i = 0; i < 8; i++) assert.equal((await limiter.precheck(S)).allowed, true); // all in flight before any failure lands
    return Promise.all(Array.from({ length: 8 }, () => limiter.recordFailure(S)));
  };
  const first = await burst();
  assert.deepEqual(first.map((r) => r.failures).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8], 'f went past the limit');
  assert.deepEqual(first.filter((r) => r.blockSeconds > 0).map((r) => [r.failures, r.blockSeconds]), [[3, 20]], 'only f === max blocks');
  assert.deepEqual([row()?.strikes, row()?.block_ms, row()?.inflight], [1, 20_000, 0], 'one strike, one 20 s block, every slot released');
  assert.deepEqual(await limiter.precheck(S), { allowed: false, code: 'source_blocked', retryAfter: 20 });
  await limiter.release(S);

  clock.advance(20_000); // block and failure window both over
  const second = await burst();
  assert.deepEqual(second.filter((r) => r.blockSeconds > 0).map((r) => [r.failures, r.blockSeconds]), [[3, 40]]);
  assert.deepEqual([row()?.strikes, row()?.block_ms], [2, 40_000]);
});

test('inflight: more than AUTH_MAX_INFLIGHT concurrent evaluations is auth_busy; a slot lasts 60 s', async () => {
  const { limiter, row } = setup({ maxInflight: 2 });
  assert.equal((await limiter.precheck(S)).allowed, true);
  assert.equal((await limiter.precheck(S)).allowed, true);
  assert.deepEqual(await limiter.precheck(S), { allowed: false, code: 'auth_busy', retryAfter: 1 });
  assert.equal(row()?.inflight_ms, 60_000);
  await limiter.release(S); // the rejected request's slot
  await limiter.release(S);
  assert.equal((await limiter.precheck(S)).allowed, true);
});

test('inflight: a release that arrives after its slot expired does not let a source exceed AUTH_MAX_INFLIGHT', async () => {
  const { clock, limiter, row } = setup({ maxInflight: 2 });
  assert.equal((await limiter.precheck(S)).allowed, true);
  clock.advance(61_000); // a request outlived the 60 s slot
  await limiter.release(S);
  assert.equal(row(), null, 'nothing active: the row is gone, never a negative count');
  assert.equal((await limiter.precheck(S)).allowed, true);
  assert.equal(row()?.inflight, 1);
  assert.equal((await limiter.precheck(S)).allowed, true);
  assert.deepEqual(await limiter.precheck(S), { allowed: false, code: 'auth_busy', retryAfter: 1 });
});

test('precheck returns the stored provider keys from the same store call', async () => {
  const { raw, limiter } = setup();
  await raw.setProviderKey('claude', '{"v":1}', '2026-10-21T12:00:00.000Z');
  const pre = await limiter.precheck(S);
  assert.ok(pre.allowed);
  assert.deepEqual(pre.allowed && pre.keys, { claude: '{"v":1}' });
});

/** Handler-level limiter behavior (memory store, fake clock, sleeps recorded instead of slept). */
const LIMIT_ENV = {
  AUTH_MAX_FAILURES: '3',
  AUTH_WINDOW_SECONDS: '20',
  AUTH_BLOCK_SECONDS: '30',
  AUTH_BACKOFF_BASE_MS: '10',
  AUTH_BACKOFF_MAX_MS: '50',
  TRUST_PROXY_HEADERS: '1',
};
/** @param {string} ip @param {string} [password] */
const from = (ip, password) => ({ headers: { ...bearer(password), 'x-vercel-forwarded-for': ip } });

test('handler: block after max failures, correct password refused while blocked, accepted after expiry', async () => {
  const clock = fakeClock();
  const h = await makeHarness({ clock, env: LIMIT_ENV });
  const ip = '198.51.100.1';
  const statuses = [];
  for (let i = 0; i < 3; i++) {
    const r = await h.call('/control/health', from(ip, WRONG_PASSWORD));
    statuses.push([r.status, r.json.error.code, r.headers.get('retry-after')]);
    clock.advance(100);
  }
  assert.deepEqual(statuses, [
    [401, 'invalid_credentials', null],
    [401, 'invalid_credentials', '1'],
    [401, 'invalid_credentials', '30'],
  ]);
  assert.deepEqual(h.sleeps, [10, 20], 'sleeps min(wait, 1000) ms before answering');
  const blocked = await h.call('/control/health', from(ip));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error.code, 'source_blocked');
  assert.equal(blocked.headers.get('retry-after'), '30');
  clock.advance(15000);
  assert.equal((await h.call('/control/health', from(ip))).headers.get('retry-after'), '15');
  clock.advance(15000);
  assert.equal((await h.call('/control/health', from(ip))).status, 200);
});

test('handler: backoff 429 auth_backoff before the wait elapses; long waits sleep at most 1000 ms', async () => {
  const clock = fakeClock();
  const h = await makeHarness({ clock, env: { ...LIMIT_ENV, AUTH_BACKOFF_BASE_MS: '1500', AUTH_BACKOFF_MAX_MS: '5000' } });
  const ip = '198.51.100.2';
  await h.call('/control/health', from(ip, WRONG_PASSWORD));
  const second = await h.call('/control/health', from(ip, WRONG_PASSWORD));
  assert.equal(second.status, 401);
  assert.equal(second.headers.get('retry-after'), '2');
  assert.deepEqual(h.sleeps, [1000]);
  const early = await h.call('/control/health', from(ip));
  assert.equal(early.status, 429);
  assert.equal(early.json.error.code, 'auth_backoff');
  assert.equal(early.headers.get('retry-after'), '2');
  clock.advance(1500);
  assert.equal((await h.call('/control/health', from(ip))).status, 200);
});

test('handler: IPv6 /64 grouping and source isolation', async () => {
  const clock = fakeClock();
  const h = await makeHarness({ clock, env: LIMIT_ENV });
  for (let i = 0; i < 3; i++) {
    await h.call('/control/health', from('2001:db8:1:2::1', WRONG_PASSWORD));
    clock.advance(100);
  }
  const sameBucket = await h.call('/control/health', from('2001:db8:1:2:ffff:ffff:ffff:ffff'));
  assert.equal(sameBucket.status, 429);
  assert.equal(sameBucket.json.error.code, 'source_blocked');
  assert.equal((await h.call('/control/health', from('2001:db8:1:3::1'))).status, 200, 'different /64');
  assert.equal((await h.call('/control/health', from('198.51.100.3'))).status, 200, 'different source');
});

test('handler: a missing credential is not counted and makes no store call', async () => {
  const raw = createMemoryStore();
  let calls = 0;
  /** @type {any} */
  const spy = { kind: 'memory' };
  for (const name of STORE_METHODS) spy[name] = (/** @type {unknown[]} */ ...args) => (calls++, /** @type {any} */ (raw)[name](...args));
  const h = await makeHarness({ store: spy });
  for (const headers of [{}, { authorization: 'Basic dXNlcjpwYXNz' }, { authorization: 'Bearer ' }, { 'x-api-key': 'k' }]) {
    const r = await h.call('/control/health', { headers });
    assert.equal(r.status, 401);
    assert.equal(r.json.error.code, 'missing_credentials');
  }
  await h.settle();
  assert.equal(calls, 0);
  assert.deepEqual(raw.dump(), { auth_sources: [], provider_keys: [], usage_daily: [], events: [] });
});

/** A store whose every method behaves the same way. @param {(...args: any[]) => Promise<any>} behavior */
const storeWith = (behavior) => Object.fromEntries([['kind', 'test'], ...STORE_METHODS.map((name) => [name, behavior])]);

test('handler: store down -> 503 store_unavailable without evaluating the password', async () => {
  let evaluations = 0;
  const h = await makeHarness({
    store: storeWith(async () => {
      throw new Error('connection refused');
    }),
    verifyPassword: async (/** @type {any} */ p, /** @type {string} */ s) => (evaluations++, verifyPassword(p, s)),
  });
  const r = await h.call('/control/health', { headers: bearer() });
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'store_unavailable');
  assert.equal(evaluations, 0);
});

test('handler: store slower than 1500 ms -> 503 store_unavailable without evaluating the password', async () => {
  let evaluations = 0;
  const h = await makeHarness({
    store: storeWith(() => new Promise((resolve) => setTimeout(() => resolve({ blockUntilMs: null, waitUntilMs: null, failures: 0, inflight: 1, keys: {} }), 1700))),
    verifyPassword: async (/** @type {any} */ p, /** @type {string} */ s) => (evaluations++, verifyPassword(p, s)),
  });
  const t = performance.now();
  const r = await h.call('/control/health', { headers: bearer() });
  const elapsed = performance.now() - t;
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'store_unavailable');
  assert.equal(evaluations, 0);
  assert.ok(elapsed >= 1450 && elapsed < 1700, `elapsed ${elapsed}`);
});
