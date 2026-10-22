// Two dev/server.js instances sharing one fake Upstash: cross-instance blocking, the concurrency
// bound under a burst, source isolation, and fail-closed behavior when the store is down.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PASSWORD, ROUTER_SECRET, STORE_TOKEN, WRONG_PASSWORD, passwordHash } from '../helpers/fixtures.js';
import { startDevServer, startFakeUpstash, upstash } from '../helpers/processes.js';
import { loadConfig } from '../../src/config.js';
import { limiterKeys } from '../../src/limiter.js';
import { normalizeAddress, sourceId } from '../../src/source.js';

const LIMITS = {
  AUTH_MAX_FAILURES: '5',
  AUTH_MAX_INFLIGHT: '10',
  AUTH_WINDOW_SECONDS: '600',
  AUTH_BLOCK_SECONDS: '60',
  AUTH_BACKOFF_BASE_MS: '20',
  AUTH_BACKOFF_MAX_MS: '80',
  TRUST_PROXY_HEADERS: '1',
};
const MAX_EVALUATIONS = Number(LIMITS.AUTH_MAX_FAILURES) + Number(LIMITS.AUTH_MAX_INFLIGHT);

/** @type {Record<string, Awaited<ReturnType<typeof startDevServer>>>} */
const procs = {};

before(async () => {
  // A slower scrypt (16 MiB, tens of ms) keeps evaluations in flight while the burst arrives.
  const hash = await passwordHash(PASSWORD, { logN: 14, r: 8, p: 1 });
  const [fake, down] = await Promise.all([startFakeUpstash(STORE_TOKEN), startFakeUpstash(STORE_TOKEN, ['--fail'])]);
  Object.assign(procs, { fake, down });
  const env = (/** @type {string} */ url) => ({
    ROUTER_PASSWORD_HASH: hash,
    ROUTER_SECRET,
    KV_REST_API_URL: url,
    KV_REST_API_TOKEN: STORE_TOKEN,
    ...LIMITS,
  });
  const [a, b, onDown] = await Promise.all([startDevServer(env(fake.url)), startDevServer(env(fake.url)), startDevServer(env(down.url))]);
  Object.assign(procs, { a, b, onDown });
});
after(async () => {
  await Promise.all(Object.values(procs).map((p) => p.stop()));
});

/**
 * @param {string} base
 * @param {string} password
 * @param {string} ip
 */
async function health(base, password, ip) {
  const res = await fetch(`${base}/control/health`, { headers: { authorization: `Bearer ${password}`, 'x-vercel-forwarded-for': ip } });
  const json = await res.json().catch(() => null);
  return { status: res.status, code: json?.error?.code ?? null, retryAfter: res.headers.get('retry-after') };
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

test('cross-instance: failures through A block the source on B, even for the correct password', async () => {
  const ip = '198.51.100.20';
  let failures = 0;
  for (let i = 0; i < 100; i++) {
    const r = await health(procs.a.url, WRONG_PASSWORD, ip);
    if (r.status === 401) failures++;
    else if (r.code === 'auth_backoff') await sleep(30);
    else if (r.code === 'source_blocked') break;
    else assert.fail(`unexpected ${JSON.stringify(r)}`);
  }
  assert.equal(failures, Number(LIMITS.AUTH_MAX_FAILURES));
  const onB = await health(procs.b.url, PASSWORD, ip);
  assert.equal(onB.status, 429);
  assert.equal(onB.code, 'source_blocked');
  assert.ok(Number(onB.retryAfter) > 0 && Number(onB.retryAfter) <= 60, String(onB.retryAfter));
  assert.equal((await health(procs.a.url, PASSWORD, ip)).code, 'source_blocked');
  assert.equal((await health(procs.b.url, PASSWORD, '198.51.100.21')).status, 200, 'another source is unaffected');
});

test(`burst: 200 concurrent wrong guesses across both instances -> at most ${MAX_EVALUATIONS} evaluations`, async () => {
  const ip = '198.51.100.30';
  const results = await Promise.all(
    Array.from({ length: 200 }, (_, i) => health(i % 2 ? procs.a.url : procs.b.url, `${WRONG_PASSWORD}-${i}`, ip)),
  );
  /** @type {Record<string, number>} */
  const tally = {};
  for (const r of results) tally[`${r.status}:${r.code}`] = (tally[`${r.status}:${r.code}`] ?? 0) + 1;
  const invalid = tally['401:invalid_credentials'] ?? 0;
  assert.ok(invalid >= 1 && invalid <= MAX_EVALUATIONS, JSON.stringify(tally));
  for (const key of Object.keys(tally)) {
    assert.ok(['401:invalid_credentials', '429:auth_busy', '429:auth_backoff', '429:source_blocked'].includes(key), JSON.stringify(tally));
  }
  assert.equal(results.filter((r) => r.status === 429).length, 200 - invalid);
  for (const base of [procs.a.url, procs.b.url]) {
    const correct = await health(base, PASSWORD, ip);
    assert.equal(correct.status, 429, JSON.stringify(tally));
    assert.equal(correct.code, 'source_blocked');
  }
  assert.equal((await health(procs.a.url, PASSWORD, '198.51.100.31')).status, 200, 'a different source is unaffected');
  // One burst is one strike: a single first-level block, however far the failure count went.
  const keys = limiterKeys(sourceId(loadConfig({ ROUTER_SECRET }).sourceKey, normalizeAddress(ip).key));
  const store = (/** @type {unknown[]} */ cmd) => upstash(procs.fake.url, STORE_TOKEN, cmd).then((r) => r.result);
  const [failCount, strikes, blockTtl] = await Promise.all([store(['GET', keys.fail]), store(['GET', keys.strikes]), store(['TTL', keys.block])]);
  assert.ok(Number(failCount) >= Number(LIMITS.AUTH_MAX_FAILURES), `fail=${failCount}`);
  assert.equal(strikes, '1', `fail=${failCount}`);
  assert.ok(blockTtl > 0 && blockTtl <= Number(LIMITS.AUTH_BLOCK_SECONDS), `block TTL ${blockTtl}`);
});

test('store down: 503 store_unavailable, and a wrong password is not evaluated (no 401)', async () => {
  for (const password of [PASSWORD, WRONG_PASSWORD]) {
    const r = await health(procs.onDown.url, password, '198.51.100.40');
    assert.deepEqual([r.status, r.code], [503, 'store_unavailable']);
  }
});
