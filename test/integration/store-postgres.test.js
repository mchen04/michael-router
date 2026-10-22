// Postgres-only store behaviour on a task-local cluster: exact results and no deadlock under
// concurrency across many pool clients; the pool and TLS options (built, never connected); and
// fail-closed requests through the handler when the database is unmigrated, slow (a held row
// lock), refuses the password, or is down. The last test stops the cluster.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { verifyPassword } from '../../src/auth.js';
import { loadConfig } from '../../src/config.js';
import { normalizeAddress, sourceId } from '../../src/source.js';
import { STORE_TIMEOUT_MS, StoreError } from '../../src/store/contract.js';
import { createStore } from '../../src/store/index.js';
import { createPostgresStore } from '../../src/store/postgres.js';
import { PASSWORD, ROUTER_SECRET, WRONG_PASSWORD, baseEnv, bearer } from '../helpers/fixtures.js';
import { makeHarness } from '../helpers/harness.js';
import { dumpRouterTables, generatedPassword, migrate, startPostgres, storeConfig, withClient } from '../helpers/postgres.js';

const T0 = Date.parse('2026-10-21T12:00:00Z');
const range = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => i + 1);
const byNumber = (/** @type {number} */ a, /** @type {number} */ b) => a - b;

/** @type {Awaited<ReturnType<typeof startPostgres>>} */
let cluster;
/** @type {import('pg').Pool[]} pools the handlers built (ended after the file) */
const pools = [];
let verifies = 0;

before(async () => {
  cluster = await startPostgres();
});
after(async () => {
  await Promise.all(pools.map((p) => p.end().catch(() => {})));
  await cluster?.stop();
});

/** @param {string} name */
async function migratedStore(name, max = 20) {
  const url = await cluster.createDatabase(name);
  await migrate(url);
  return { url, store: createPostgresStore(storeConfig(url), { max }) };
}

/** A handler whose store comes from DATABASE_URL, counting password evaluations. @param {string} url */
const handlerFor = (url) =>
  makeHarness({
    store: null,
    env: { ROUTER_STORE: /** @type {any} */ (undefined), DATABASE_URL: url },
    verifyPassword: async (/** @type {any} */ parsed, /** @type {string} */ presented) => {
      verifies++;
      return verifyPassword(parsed, presented);
    },
    attachDatabasePool: (pool) => pools.push(pool),
  });

/** @param {Awaited<ReturnType<typeof makeHarness>>} h @param {string} [password] @param {string} [address] */
const health = (h, password = PASSWORD, address = '127.0.0.1') => h.call('/control/health', { headers: bearer(password) }, { remoteAddress: address });

test('50 parallel failures on one source: counts exactly 1..50 and exactly one strike', async () => {
  const { store } = await migratedStore('burst_failures');
  try {
    const limits = { windowMs: 600_000, maxFailures: 8 };
    const results = await Promise.all(range(50).map(() => store.authFailure('burst', T0, limits)));
    assert.deepEqual(results.map((r) => r.failures).sort(byNumber), range(50));
    assert.deepEqual(results.filter((r) => r.strikes !== null), [{ failures: 8, strikes: 1 }]);
  } finally {
    await store.close();
  }
});

test('100 parallel prechecks: inflight exactly 1..100; after 100 releases the row is gone', async () => {
  const { url, store } = await migratedStore('burst_inflight');
  try {
    const pre = await Promise.all(range(100).map(() => store.authPrecheck('wide', T0)));
    assert.deepEqual(pre.map((p) => p.inflight).sort(byNumber), range(100));
    await Promise.all(range(100).map(() => store.authRelease('wide', T0 + 1)));
    const { rows } = await withClient(url, (c) => c.query("SELECT count(*)::int AS n FROM michael_router.auth_sources WHERE source = 'wide'"));
    assert.equal(rows[0].n, 0);
  } finally {
    await store.close();
  }
});

test('20 parallel usage writers with shuffled entries: exact totals, no deadlock or serialization failure', async () => {
  const { url, store } = await migratedStore('burst_usage');
  try {
    const old = { retainFromDay: '2025-01-01' };
    await store.addUsage('2025-06-01', range(30).map((i) => ({ provider: 'claude', model: `old-${i}`, metric: 'requests', value: 1 })), old);
    /** @type {{provider: string, model: string, metric: string, value: number}[]} */
    const entries = [];
    for (const provider of ['claude', 'gemini', 'openrouter']) {
      for (const model of ['m-a', 'm-b', 'M-c', 'm_d']) {
        for (const [k, metric] of ['requests', 'input_tokens', 'output_tokens'].entries()) entries.push({ provider, model, metric, value: k + 1 });
      }
    }
    const shuffle = () => entries.map((e) => [Math.random(), e]).sort((a, b) => Number(a[0]) - Number(b[0])).map(([, e]) => /** @type {typeof e} */ (e));
    const ROUNDS = 10;
    const writers = range(20).map(async () => {
      for (let r = 0; r < ROUNDS; r++) await store.addUsage('2026-10-21', shuffle(), { retainFromDay: '2025-09-17' });
    });
    const settled = await Promise.allSettled(writers);
    const failed = settled.flatMap((s) => (s.status === 'rejected' ? [`${s.reason?.name} ${s.reason?.sqlstate}`] : []));
    assert.deepEqual(failed, [], 'no writer failed (40P01 = deadlock, 40001 = serialization)');
    const rows = await store.readUsage('2000-01-01', '2100-12-31');
    assert.equal(rows.length, entries.length, 'the old day was purged');
    for (const e of entries) {
      const row = rows.find((r) => r.provider === e.provider && r.model === e.model && r.metric === e.metric);
      assert.equal(row?.value, e.value * 20 * ROUNDS, JSON.stringify(e));
    }
    const { rows: old2025 } = await withClient(url, (c) => c.query("SELECT count(*)::int AS n FROM michael_router.usage_daily WHERE day < '2025-09-17'"));
    assert.equal(old2025[0].n, 0);
  } finally {
    await store.close();
  }
});

test('300 parallel event appends: at most 200 rows remain, the newest, listed newest first, all valid JSON', async () => {
  const { url, store } = await migratedStore('burst_events');
  try {
    await Promise.all(range(300).map((i) => store.appendEvent(JSON.stringify({ kind: 'auth', i }), 200)));
    const listed = await store.listEvents(1000);
    const { rows } = await withClient(url, (c) => c.query('SELECT id, event::text AS event FROM michael_router.events ORDER BY id DESC'));
    assert.ok(rows.length > 0 && rows.length <= 200, `${rows.length} rows`);
    assert.deepEqual(listed, rows.map((r) => r.event), 'listed newest (highest id) first');
    const ids = rows.map((r) => Number(r.id));
    assert.ok(Math.min(...ids) > 300 - 200, `kept ids ${Math.min(...ids)}..${Math.max(...ids)} are the newest`);
    assert.equal(new Set(listed.map((t) => JSON.parse(t).i)).size, listed.length);
  } finally {
    await store.close();
  }
});

test('pool and TLS options: the handler hands its pool to attachDatabasePool; TLS is verify-full with channel binding and no pg SECURITY WARNING', async () => {
  const { attachDatabasePool } = await import('@vercel/functions');
  assert.equal(typeof attachDatabasePool, 'function', 'api/router.js imports it');
  const raw = 'postgresql://router:pw-SENTINEL-tls@db-pooler.example.test/router?sslmode=require&channel_binding=require';
  const config = loadConfig({ ...(await baseEnv()), ROUTER_STORE: /** @type {any} */ (undefined), VERCEL: '1', DATABASE_URL_POOLED: raw });
  assert.deepEqual([...config.problems], []);
  /** @type {string[]} */
  const warnings = [];
  const emitWarning = process.emitWarning;
  process.emitWarning = /** @type {any} */ ((/** @type {unknown} */ w) => warnings.push(String(w)));
  /** @type {import('pg').Pool[]} */
  const built = [];
  let store;
  try {
    store = /** @type {any} */ (createStore(config.store, { onPool: (pool) => built.push(pool) }));
    assert.equal(built.length, 1);
    const o = /** @type {any} */ (built[0]).options;
    assert.deepEqual(
      { max: o.max, idle: o.idleTimeoutMillis, connect: o.connectionTimeoutMillis, app: o.application_name, ssl: o.ssl, binding: o.enableChannelBinding },
      { max: 5, idle: 10_000, connect: 5000, app: 'michael-router', ssl: { rejectUnauthorized: true }, binding: true },
    );
    assert.equal(new URL(o.connectionString).search, '', 'sslmode and channel_binding are not passed to pg');
    for (const startup of ['statement_timeout', 'options', 'lock_timeout']) assert.equal(o[startup], undefined, startup);
    const client = /** @type {any} */ (new pg.Client(o)); // parses the URL as each pool client does; never connects
    assert.deepEqual([client.host, client.ssl, client.enableChannelBinding], ['db-pooler.example.test', { rejectUnauthorized: true }, true]);
    assert.deepEqual(warnings, []);
    new pg.Client({ connectionString: raw }); // control: pg's own sslmode=require handling does warn
    assert.match(warnings.join('\n'), /SECURITY WARNING/);
  } finally {
    process.emitWarning = emitWarning;
    await store?.close();
  }
});

test('unmigrated database: 503 store_unavailable, the password is never evaluated, and the request migrates nothing', async () => {
  const url = await cluster.createDatabase('unmigrated');
  const h = await handlerFor(url);
  const before = verifies;
  for (const password of [PASSWORD, WRONG_PASSWORD]) {
    const r = await health(h, password);
    assert.deepEqual([r.status, r.json?.error?.code], [503, 'store_unavailable']);
  }
  await h.settle();
  assert.equal(verifies, before);
  const { rows } = await withClient(url, (c) => c.query("SELECT to_regnamespace('michael_router') IS NULL AS absent"));
  assert.equal(rows[0].absent, true);
});

test('a statement held up by a row lock: 503 within the statement budget, other sources unaffected, and the pool recovers', async () => {
  const url = await cluster.createDatabase('slow');
  await migrate(url);
  const h = await handlerFor(url);
  assert.equal((await health(h)).status, 200);
  await h.settle();
  const source = sourceId(loadConfig({ ROUTER_SECRET }).sourceKey, normalizeAddress('127.0.0.1').key);
  const holder = new pg.Client({ connectionString: url });
  holder.on('error', () => {});
  await holder.connect();
  try {
    await holder.query('INSERT INTO michael_router.auth_sources (source) VALUES ($1) ON CONFLICT DO NOTHING', [source]);
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM michael_router.auth_sources WHERE source = $1 FOR UPDATE', [source]);
    const before = verifies;
    const t = performance.now();
    const r = await health(h);
    const elapsed = performance.now() - t;
    assert.deepEqual([r.status, r.json?.error?.code], [503, 'store_unavailable']);
    assert.ok(elapsed >= STORE_TIMEOUT_MS - 50 && elapsed < STORE_TIMEOUT_MS + 1000, `${Math.round(elapsed)} ms`);
    assert.equal(verifies, before, 'not evaluated');
    assert.equal((await health(h, PASSWORD, '127.0.0.2')).status, 200, 'another source is served meanwhile');
  } finally {
    await holder.query('ROLLBACK').catch(() => {});
    await holder.end();
  }
  assert.equal((await health(h)).status, 200, 'after the lock goes the source is served again');
  await h.settle();
});

test('wrong database password: 503, and no response, log line, error or row holds the URL or either password', async () => {
  const password = generatedPassword();
  const url = await cluster.createDatabase('wrong_password', { password });
  await migrate(url);
  const wrong = generatedPassword();
  const wrongUrl = url.replace(`:${encodeURIComponent(password)}@`, `:${encodeURIComponent(wrong)}@`);
  assert.notEqual(wrongUrl, url);
  const h = await handlerFor(wrongUrl);
  const before = verifies;
  const r = await health(h);
  assert.deepEqual([r.status, r.json?.error?.code], [503, 'store_unavailable']);
  await h.settle();
  assert.equal(verifies, before);

  const direct = createPostgresStore(storeConfig(wrongUrl));
  /** @type {any} */
  let err;
  try {
    await direct.authPrecheck('s', T0);
  } catch (e) {
    err = e;
  } finally {
    await direct.close();
  }
  assert.ok(err instanceof StoreError);
  assert.deepEqual([err.message, err.sqlstate, err.cause], ['store connection failed', '28P01', undefined]);

  const rows = JSON.stringify(await dumpRouterTables(url));
  const seen = [r.text, ...h.logs, String(err.stack), JSON.stringify(err), rows].join('\n');
  for (const secret of [url, wrongUrl, password, wrong, cluster.dir, encodeURIComponent(cluster.dir)]) assert.ok(!seen.includes(secret), 'a secret leaked');
  assert.ok(!seen.includes('SENTINEL'));
  assert.ok(h.logs.length > 0, 'the request was logged');
});

test('postgres stopped: 503 store_unavailable and the password is never evaluated', async () => {
  const url = await cluster.createDatabase('stopped');
  await migrate(url);
  const h = await handlerFor(url);
  assert.equal((await health(h)).status, 200);
  await h.settle();
  const before = verifies;
  await cluster.stop();
  for (const password of [PASSWORD, WRONG_PASSWORD]) {
    const r = await health(h, password);
    assert.deepEqual([r.status, r.json?.error?.code], [503, 'store_unavailable']);
  }
  await h.settle();
  assert.equal(verifies, before);
});
