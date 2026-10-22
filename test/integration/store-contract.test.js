// One set of store-contract cases, run against both stores: the in-process memory store and the
// Postgres store on a freshly migrated database of a task-local cluster. Every interface method,
// the expiry of every limiter field under a fake clock, and literal round trips of hostile strings.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { INFLIGHT_TTL_MS, STORE_METHODS, STRIKES_TTL_MS, SWEEP_LIMIT } from '../../src/store/contract.js';
import { createMemoryStore } from '../../src/store/memory.js';
import { LATEST_SCHEMA_VERSION } from '../../src/store/migrations.js';
import { createPostgresStore } from '../../src/store/postgres.js';
import { migrate, startPostgres, storeConfig, withClient } from '../helpers/postgres.js';

const T0 = Date.parse('2026-10-21T12:00:00Z');

/** @type {Awaited<ReturnType<typeof startPostgres>>} */
let cluster;
before(async () => {
  cluster = await startPostgres();
});
after(async () => {
  await cluster?.stop();
});

/**
 * @typedef {{store: any, authRow: (source: string) => Promise<Record<string, any> | undefined>,
 *   sources: () => Promise<string[]>, close: () => Promise<void>}} Backend
 */

/** @type {Record<string, (name: string) => Promise<Backend>>} */
const BACKENDS = {
  async memory() {
    const store = createMemoryStore();
    const rows = () => store.dump().auth_sources;
    return {
      store,
      authRow: async (source) => rows().find((r) => r.source === source),
      sources: async () => rows().map((r) => r.source).sort(),
      close: async () => {},
    };
  },
  async postgres(name) {
    const url = await cluster.createDatabase(name);
    await migrate(url);
    const store = createPostgresStore(storeConfig(url));
    const rows = () =>
      withClient(url, (c) => c.query('SELECT * FROM michael_router.auth_sources')).then((r) =>
        r.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, k === 'source' ? v : Number(v)]))),
      );
    return {
      store,
      authRow: async (source) => (await rows()).find((r) => r.source === source),
      sources: async () => (await rows()).map((r) => r.source).sort(),
      close: () => store.close(),
    };
  },
};

/** @param {{day: string, provider: string, model: string, metric: string, value: number}[]} rows */
const sorted = (rows) => rows.map((r) => JSON.stringify([r.day, r.provider, r.model, r.metric, r.value])).sort();

/** @type {[string, (b: Backend) => Promise<void>][]} */
const CASES = [
  [
    'a fresh store: ping reports the schema version and nothing is stored',
    async ({ store, sources }) => {
      for (const m of STORE_METHODS) assert.equal(typeof store[m], 'function', m);
      assert.deepEqual(await store.ping(), { schemaVersion: LATEST_SCHEMA_VERSION });
      assert.deepEqual(await store.listEvents(200), []);
      assert.deepEqual(await store.readUsage('2000-01-01', '2100-12-31'), []);
      assert.equal(await store.deleteProviderKey('claude'), false);
      await store.authRelease('nobody', T0); // no row: nothing to release
      await store.authPenalty('nobody', T0, { waitUntilMs: null, blockUntilMs: null });
      assert.deepEqual(await sources(), []);
    },
  ],
  [
    'inflight: a precheck holds a slot for 60 s, a release frees it (never below zero), and a source with nothing active is deleted',
    async ({ store, authRow }) => {
      const s = 'src-inflight';
      assert.deepEqual(await store.authPrecheck(s, T0), { blockUntilMs: null, waitUntilMs: null, failures: 0, inflight: 1, keys: {} });
      assert.equal((await store.authPrecheck(s, T0 + 1)).inflight, 2);
      await store.authRelease(s, T0 + 2);
      assert.equal((await authRow(s))?.inflight, 1);
      await store.authRelease(s, T0 + 3);
      assert.equal(await authRow(s), undefined, 'nothing active: the row is deleted');
      await store.authRelease(s, T0 + 4);
      assert.equal(await authRow(s), undefined, 'a late release creates nothing');

      // Leaked slots (no release) expire 60 s after the latest precheck, and the count restarts.
      await store.authPrecheck(s, T0);
      await store.authPrecheck(s, T0 + 1000);
      const t = T0 + 1000 + INFLIGHT_TTL_MS - 1;
      assert.equal((await store.authPrecheck(s, t)).inflight, 3, 'active until its end time');
      assert.equal((await store.authPrecheck(s, t + INFLIGHT_TTL_MS)).inflight, 1, 'expired at its end time');
      await store.authRelease(s, t + 2 * INFLIGHT_TTL_MS);
      assert.equal(await authRow(s), undefined, 'a release after the slot expired deletes the row');
    },
  ],
  [
    'failures: the first failure starts a fixed window; a strike at maxFailures escalates while strikes are active and they expire after 7 days',
    async ({ store, authRow }) => {
      const s = 'src-failures';
      const limits = { windowMs: 600_000, maxFailures: 3 };
      await store.authPrecheck(s, T0);
      assert.deepEqual(await store.authFailure(s, T0, limits), { failures: 1, strikes: null });
      assert.deepEqual([(await authRow(s))?.inflight, (await authRow(s))?.failures_until_ms], [0, T0 + 600_000], 'the failure released the slot');
      assert.deepEqual(await store.authFailure(s, T0 + 1000, limits), { failures: 2, strikes: null });
      assert.equal((await authRow(s))?.failures_until_ms, T0 + 600_000, 'later failures keep the end time');
      assert.deepEqual(await store.authFailure(s, T0 + 2000, limits), { failures: 3, strikes: 1 });
      assert.deepEqual(await store.authFailure(s, T0 + 3000, limits), { failures: 4, strikes: null }, 'one strike per window');
      assert.equal((await store.authPrecheck(s, T0 + 599_999)).failures, 4);
      await store.authRelease(s, T0 + 599_999);
      assert.ok(await authRow(s), 'a penalized source is kept at zero inflight');
      assert.equal((await store.authPrecheck(s, T0 + 600_000)).failures, 0, 'the window ended at its end time');

      const t1 = T0 + 600_000;
      await store.authFailure(s, t1, limits);
      await store.authFailure(s, t1, limits);
      assert.deepEqual(await store.authFailure(s, t1, limits), { failures: 3, strikes: 2 }, 'strikes escalate while active');
      const t2 = t1 + STRIKES_TTL_MS;
      await store.authFailure(s, t2, limits);
      await store.authFailure(s, t2, limits);
      assert.deepEqual(await store.authFailure(s, t2, limits), { failures: 3, strikes: 1 }, 'the strikes expired 7 days after the last one');
      await store.authRelease(s, t2 + STRIKES_TTL_MS);
      assert.equal(await authRow(s), undefined, 'every end time passed: the row is deleted');

      assert.deepEqual(await store.authFailure('src-strict', T0, { windowMs: 1000, maxFailures: 1 }), { failures: 1, strikes: 1 }, 'a first failure can strike');
    },
  ],
  [
    'penalties: wait and block never shorten, either may be null, and each is reported only while active',
    async ({ store, authRow }) => {
      const s = 'src-penalty';
      await store.authPenalty(s, T0, { waitUntilMs: T0 + 500, blockUntilMs: null });
      let pre = await store.authPrecheck(s, T0);
      assert.deepEqual([pre.waitUntilMs, pre.blockUntilMs], [T0 + 500, null]);
      await store.authPenalty(s, T0, { waitUntilMs: T0 + 100, blockUntilMs: T0 + 60_000 });
      await store.authPenalty(s, T0, { waitUntilMs: null, blockUntilMs: T0 + 30_000 });
      pre = await store.authPrecheck(s, T0 + 1);
      assert.deepEqual([pre.waitUntilMs, pre.blockUntilMs], [T0 + 500, T0 + 60_000], 'shorter values do not shorten');
      pre = await store.authPrecheck(s, T0 + 500);
      assert.deepEqual([pre.waitUntilMs, pre.blockUntilMs], [null, T0 + 60_000], 'the wait ended at its end time');
      pre = await store.authPrecheck(s, T0 + 60_000);
      assert.deepEqual([pre.waitUntilMs, pre.blockUntilMs, pre.failures, pre.inflight], [null, null, 0, 4]);
      for (let i = 0; i < 4; i++) await store.authRelease(s, T0 + 60_000);
      assert.equal(await authRow(s), undefined);
    },
  ],
  [
    'sweep: a failure deletes up to the sweep limit of dead rows of other sources, oldest first, and keeps live ones',
    async ({ store, sources }) => {
      const limits = { windowMs: 1000, maxFailures: 5 };
      const dead = Array.from({ length: SWEEP_LIMIT + 2 }, (_, i) => `dead-${String(i).padStart(3, '0')}`);
      for (const [i, s] of dead.entries()) await store.authFailure(s, T0 + i, limits); // ends at T0 + 1000 + i
      await store.authPrecheck('live', T0 + 5000);
      await store.authFailure('self', T0, limits);
      await store.authFailure('self', T0 + 5000, limits);
      assert.deepEqual(await sources(), [...dead.slice(SWEEP_LIMIT), 'live', 'self'], 'the oldest dead rows went first');
      await store.authFailure('self', T0 + 5001, limits);
      assert.deepEqual(await sources(), ['live', 'self']);
    },
  ],
  [
    'provider keys: upsert, delete reports whether a record went, and every precheck returns all records',
    async ({ store }) => {
      await store.setProviderKey('claude', 'record-1', '2026-10-21T12:00:00.000Z');
      await store.setProviderKey('gemini', 'record-2', '2026-10-21T12:00:01.000Z');
      await store.setProviderKey('claude', 'record-3', '2026-10-21T12:00:02.000Z');
      assert.deepEqual((await store.authPrecheck('k', T0)).keys, { claude: 'record-3', gemini: 'record-2' });
      assert.equal(await store.deleteProviderKey('claude'), true);
      assert.equal(await store.deleteProviderKey('claude'), false);
      assert.deepEqual((await store.authPrecheck('k', T0)).keys, { gemini: 'record-2' });
      await assert.rejects(store.setProviderKey('openrouter', 'record', 'not a time'));
    },
  ],
  [
    'usage: entries add up exactly (repeats within one call too), ranges are inclusive, and days before retainFromDay are purged',
    async ({ store }) => {
      const e = (/** @type {string} */ metric, /** @type {number} */ value, model = 'claude-haiku-5-5') => ({ provider: 'claude', model, metric, value });
      const keep = { retainFromDay: '2025-09-17' };
      await store.addUsage('2026-10-20', [e('requests', 1), e('input_tokens', 10)], keep);
      await store.addUsage('2026-10-21', [e('requests', 1), e('requests', 2), e('input_tokens', 5)], keep);
      await store.addUsage('2026-10-21', [e('requests', 4), e('requests', 1, 'claude-opus-5-5')], keep);
      await store.addUsage('2026-10-21', [], keep);
      const day = (/** @type {string} */ d, /** @type {string} */ metric, /** @type {number} */ value, model = 'claude-haiku-5-5') => ({ day: d, ...e(metric, value, model) });
      assert.deepEqual(sorted(await store.readUsage('2026-10-21', '2026-10-21')), sorted([day('2026-10-21', 'requests', 7), day('2026-10-21', 'input_tokens', 5), day('2026-10-21', 'requests', 1, 'claude-opus-5-5')]));
      assert.equal((await store.readUsage('2026-10-20', '2026-10-21')).length, 5);
      assert.deepEqual(await store.readUsage('2026-10-22', '2026-10-30'), []);

      await store.addUsage('2026-10-22', [e('requests', 1)], { retainFromDay: '2026-10-21' });
      assert.deepEqual(
        (await store.readUsage('2000-01-01', '2100-12-31')).map((/** @type {any} */ r) => r.day).sort(),
        ['2026-10-21', '2026-10-21', '2026-10-21', '2026-10-22'],
        'the day before retainFromDay was purged',
      );
      for (const bad of [0, -1, 1.5, 2 ** 53, '1', null]) await assert.rejects(store.addUsage('2026-10-22', [e('requests', /** @type {any} */ (bad))], keep), String(bad));
      await assert.rejects(store.addUsage('2026-10-2', [e('requests', 1)], keep));
      await assert.rejects(store.readUsage('2026-10-22', 'tomorrow'));
    },
  ],
  [
    'events: newest first, the stored JSON text exactly as given, and at most max kept',
    async ({ store }) => {
      const texts = Array.from({ length: 7 }, (_, i) => JSON.stringify({ i, kind: 'auth', z: 1, a: 2 }));
      texts.push('{"b":1,  "a":[1, 2]}');
      for (const t of texts) await store.appendEvent(t, 5);
      assert.deepEqual(await store.listEvents(5), texts.slice(-5).reverse(), 'field order and spacing kept');
      assert.deepEqual(await store.listEvents(2), texts.slice(-2).reverse());
      await assert.rejects(store.appendEvent('{"truncated', 5));
      assert.deepEqual(await store.listEvents(200), texts.slice(-5).reverse());
    },
  ],
  [
    'hostile strings round-trip literally through sources, providers, models and records',
    async ({ store, authRow }) => {
      const hostile = [
        `it's "quoted"`,
        'back\\slash \\x00 \\\\ \\n',
        '100% _under_ %_% LIKE',
        'unicode é 漢字 🚀 ‮ right-to-left',
        "'); DROP TABLE michael_router.events; --",
        '$1 $$ dollar-quoted $$ ::text',
        `${'m'.repeat(1000)}🚀`,
      ];
      for (const [i, h] of hostile.entries()) {
        assert.equal((await store.authPrecheck(h, T0)).inflight, 1);
        assert.deepEqual(await store.authFailure(h, T0, { windowMs: 1000, maxFailures: 5 }), { failures: 1, strikes: null });
        assert.equal((await authRow(h))?.source, h);
        await store.setProviderKey(h, `${h} record`, '2026-10-21T12:00:00.000Z');
        await store.addUsage('2026-10-21', [{ provider: h, model: h, metric: 'requests', value: i + 1 }], { retainFromDay: '2025-09-17' });
        await store.appendEvent(JSON.stringify({ message: h }), 200);
      }
      const { keys } = await store.authPrecheck('k', T0);
      assert.deepEqual(keys, Object.fromEntries(hostile.map((h) => [h, `${h} record`])));
      assert.deepEqual(
        sorted(await store.readUsage('2026-10-21', '2026-10-21')),
        sorted(hostile.map((h, i) => ({ day: '2026-10-21', provider: h, model: h, metric: 'requests', value: i + 1 }))),
      );
      assert.deepEqual((await store.listEvents(200)).map((/** @type {string} */ t) => JSON.parse(t).message), [...hostile].reverse());
    },
  ],
];

for (const kind of Object.keys(BACKENDS)) {
  describe(`${kind} store`, () => {
    for (const [i, [name, fn]] of CASES.entries()) {
      test(name, async () => {
        const backend = await BACKENDS[kind](`contract_${i}`);
        try {
          await fn(backend);
        } finally {
          await backend.close();
        }
      });
    }
  });
}
