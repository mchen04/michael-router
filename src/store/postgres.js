// PostgreSQL store (Neon in production, through its PgBouncer pooler in transaction mode).
//
// Every method is one autocommitted statement, except appendEvent (insert, then trim), so nothing
// relies on session state, SET, interactive transactions or session advisory locks. Every
// statement is parameterized and names its tables as michael_router.<table>; none depends on
// search_path or interpolates a value (the CASE fragments below are constant SQL text).
//
// Atomicity and deadlock freedom:
// - auth_sources: each statement locks one row, the source's, through INSERT … ON CONFLICT DO
//   UPDATE (or SELECT … FOR UPDATE in authRelease). In READ COMMITTED both act on the latest
//   committed row version, so concurrent calls on one source serialize on that row lock and
//   none is lost. authFailure's sweep of dead rows runs after its upsert (PostgreSQL runs a data-
//   modifying WITH query that the outer query does not read once the outer query is done) and
//   takes its locks with SKIP LOCKED, so it never waits: the only lock any statement waits for is
//   the first one it takes, and a cycle cannot form.
// - usage_daily: one INSERT … SELECT FROM unnest(…) GROUP BY … ORDER BY (provider, model, metric)
//   COLLATE "C" … ON CONFLICT DO UPDATE SET value = value + excluded.value. Every writer locks its
//   rows in that one byte order, so two writers cannot wait on each other in a cycle; the purge of
//   old days uses SKIP LOCKED and never waits.
// - events: see appendEvent.
//
// Timeouts: waiting for a client (queued or newly connecting, TLS and authentication included)
// is bounded by CONNECT_TIMEOUT_MS, then the method's statements by STORE_TIMEOUT_MS. A late
// statement makes the call reject and its client is destroyed, never reused. The server may still
// finish that statement (for example after a lock it waited for is released); the effect is the
// same as a request that completed, and a precheck slot whose release never comes expires with
// its 60 s inflight end time.
import pg from 'pg';
import {
  CONNECT_TIMEOUT_MS,
  INFLIGHT_TTL_MS,
  STORE_TIMEOUT_MS,
  STRIKES_TTL_MS,
  SWEEP_LIMIT,
  StoreError,
  checkDay,
  checkMs,
  checkUsageEntries,
} from './contract.js';
import { LATEST_SCHEMA_VERSION } from './migrations.js';

const POOL_MAX = 5;
const IDLE_TIMEOUT_MS = 10_000;
/** SQLSTATEs meaning the schema (or a table in it) does not exist: the database is not migrated. */
const MISSING_SCHEMA = new Set(['3F000', '42P01']);

const noop = () => {};

/**
 * A generic StoreError for any pg failure: never the URL, host, user, password, SQL or parameters,
 * only the server's SQLSTATE.
 * @param {string} message @param {unknown} err
 */
function storeError(message, err) {
  if (err instanceof StoreError) return err;
  const sqlstate = err instanceof pg.DatabaseError ? err.code : undefined;
  if (sqlstate && MISSING_SCHEMA.has(sqlstate)) return new StoreError('store schema missing (run the migrations)', { sqlstate });
  return new StoreError(message, { sqlstate });
}

/** bigint and int columns: pg returns bigint as text. Unsafe integers are a malformed row. @param {unknown} v */
function int(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n)) throw new StoreError('malformed store row');
  return n;
}
/** @param {unknown} v */
const intOrNull = (v) => (v === null ? null : int(v));
/** @param {unknown} s */
function text(s) {
  if (typeof s !== 'string') throw new TypeError('expected a string');
  return s;
}

// Constant SQL fragments over the old row `a` ($2 = now, $3 = window ms, $4 = max failures).
const INFLIGHT_LEFT = 'GREATEST(CASE WHEN a.inflight_until_ms > $2 THEN a.inflight ELSE 0 END - 1, 0)';
const NEW_FAILURES = 'CASE WHEN a.failures_until_ms > $2 THEN a.failures + 1 ELSE 1 END';
const NEW_FAILURES_UNTIL = 'CASE WHEN a.failures_until_ms > $2 THEN a.failures_until_ms ELSE $2 + $3 END';
const STRIKE = `(${NEW_FAILURES}) = $4`;
const NEW_STRIKES = `CASE WHEN ${STRIKE} THEN (CASE WHEN a.strikes_until_ms > $2 THEN a.strikes ELSE 0 END) + 1 ELSE a.strikes END`;
const NEW_STRIKES_UNTIL = `CASE WHEN ${STRIKE} THEN $2 + $5 ELSE a.strikes_until_ms END`;

const SQL = Object.freeze({
  ping: 'SELECT max(version) AS version FROM michael_router.schema_migrations',

  authPrecheck: `WITH s AS (
  INSERT INTO michael_router.auth_sources AS a (source, inflight, inflight_until_ms, expires_ms)
  VALUES ($1, 1, $2::bigint + $3::bigint, $2 + $3)
  ON CONFLICT (source) DO UPDATE SET
    inflight = CASE WHEN a.inflight_until_ms > $2 THEN a.inflight + 1 ELSE 1 END,
    inflight_until_ms = $2 + $3,
    expires_ms = GREATEST(a.expires_ms, $2 + $3)
  RETURNING
    CASE WHEN a.block_until_ms > $2 THEN a.block_until_ms END AS block_until_ms,
    CASE WHEN a.wait_until_ms > $2 THEN a.wait_until_ms END AS wait_until_ms,
    CASE WHEN a.failures_until_ms > $2 THEN a.failures ELSE 0 END AS failures,
    a.inflight
)
SELECT s.*, (SELECT COALESCE(json_object_agg(k.provider, k.record), '{}'::json) FROM michael_router.provider_keys k) AS keys
FROM s`,

  // Lock the row, then either keep it with the decremented count or delete it when nothing in it
  // is active any more. Exactly one of the two applies.
  authRelease: `WITH cur AS (
  SELECT a.source, ${INFLIGHT_LEFT} AS inflight,
    GREATEST(a.failures_until_ms, a.wait_until_ms, a.block_until_ms, a.strikes_until_ms) > $2::bigint AS penalized
  FROM michael_router.auth_sources a WHERE a.source = $1 FOR UPDATE
), gone AS (
  DELETE FROM michael_router.auth_sources d USING cur
  WHERE d.source = cur.source AND cur.inflight = 0 AND NOT cur.penalized
)
UPDATE michael_router.auth_sources u SET inflight = cur.inflight
FROM cur WHERE u.source = cur.source AND (cur.inflight > 0 OR cur.penalized)`,

  authFailure: `WITH sweep AS (
  DELETE FROM michael_router.auth_sources d
  WHERE d.source IN (
    SELECT x.source FROM michael_router.auth_sources x
    WHERE x.expires_ms < $2 AND x.source <> $1
    ORDER BY x.expires_ms LIMIT $6
    FOR UPDATE SKIP LOCKED)
  AND d.expires_ms < $2
)
INSERT INTO michael_router.auth_sources AS a
  (source, failures, failures_until_ms, strikes, strikes_until_ms, inflight, inflight_until_ms, expires_ms)
VALUES ($1, 1, $2::bigint + $3::bigint,
  CASE WHEN $4::integer = 1 THEN 1 ELSE 0 END,
  CASE WHEN $4 = 1 THEN $2 + $5::bigint ELSE 0 END,
  0, 0,
  GREATEST($2 + $3, CASE WHEN $4 = 1 THEN $2 + $5 ELSE 0 END))
ON CONFLICT (source) DO UPDATE SET
  failures = ${NEW_FAILURES},
  failures_until_ms = ${NEW_FAILURES_UNTIL},
  strikes = ${NEW_STRIKES},
  strikes_until_ms = ${NEW_STRIKES_UNTIL},
  inflight = ${INFLIGHT_LEFT},
  expires_ms = GREATEST(a.expires_ms, ${NEW_FAILURES_UNTIL}, ${NEW_STRIKES_UNTIL})
RETURNING a.failures, CASE WHEN a.failures = $4 THEN a.strikes END AS strikes`,

  authPenalty: `INSERT INTO michael_router.auth_sources AS a (source, wait_until_ms, block_until_ms, expires_ms)
VALUES ($1, COALESCE($2::bigint, 0), COALESCE($3::bigint, 0), GREATEST(COALESCE($2, 0), COALESCE($3, 0)))
ON CONFLICT (source) DO UPDATE SET
  wait_until_ms = GREATEST(a.wait_until_ms, COALESCE($2, 0)),
  block_until_ms = GREATEST(a.block_until_ms, COALESCE($3, 0)),
  expires_ms = GREATEST(a.expires_ms, COALESCE($2, 0), COALESCE($3, 0))`,

  setProviderKey: `INSERT INTO michael_router.provider_keys (provider, record, updated_at) VALUES ($1, $2, $3::timestamptz)
ON CONFLICT (provider) DO UPDATE SET record = excluded.record, updated_at = excluded.updated_at`,

  deleteProviderKey: 'DELETE FROM michael_router.provider_keys WHERE provider = $1',

  addUsage: `WITH purge AS (
  DELETE FROM michael_router.usage_daily d
  WHERE (d.day, d.provider, d.model, d.metric) IN (
    SELECT o.day, o.provider, o.model, o.metric FROM michael_router.usage_daily o
    WHERE o.day < $2::date FOR UPDATE SKIP LOCKED)
)
INSERT INTO michael_router.usage_daily AS u (day, provider, model, metric, value)
SELECT $1::date, e.provider, e.model, e.metric, sum(e.value)::bigint
FROM unnest($3::text[], $4::text[], $5::text[], $6::bigint[]) AS e (provider, model, metric, value)
GROUP BY e.provider, e.model, e.metric
ORDER BY e.provider COLLATE "C", e.model COLLATE "C", e.metric COLLATE "C"
ON CONFLICT (day, provider, model, metric) DO UPDATE SET value = u.value + excluded.value`,

  readUsage: `SELECT to_char(day, 'YYYY-MM-DD') AS day, provider, model, metric, value
FROM michael_router.usage_daily WHERE day BETWEEN $1::date AND $2::date
ORDER BY day, provider COLLATE "C", model COLLATE "C", metric COLLATE "C"`,

  appendEvent: 'INSERT INTO michael_router.events (event) VALUES ($1::json)',

  // A separate statement after the insert committed: its snapshot then includes this event and
  // every event whose insert committed earlier, so the last trim to start sees every row and
  // leaves at most `max`. Rows another trim holds are skipped (that trim deletes them), so no
  // trim ever waits.
  trimEvents: `DELETE FROM michael_router.events d
WHERE d.id IN (
  SELECT o.id FROM michael_router.events o
  WHERE o.id <= (SELECT max(m.id) FROM michael_router.events m) - $1::bigint
  FOR UPDATE SKIP LOCKED)`,

  listEvents: 'SELECT event::text AS event FROM michael_router.events ORDER BY id DESC LIMIT $1',
});

/**
 * @param {{connectionString: string, ssl: boolean, channelBinding: boolean}} config from src/config.js
 * @param {{onPool?: (pool: pg.Pool) => void, max?: number, statementTimeoutMs?: number}} [options]
 *   onPool: called once with the pool (Vercel's attachDatabasePool); max and statementTimeoutMs for tests
 * @returns {import('./contract.js').Store & {close: () => Promise<void>}}
 */
export function createPostgresStore({ connectionString, ssl, channelBinding }, { onPool, max = POOL_MAX, statementTimeoutMs = STORE_TIMEOUT_MS } = {}) {
  const pool = new pg.Pool({
    connectionString,
    // verify-full: the system CAs, and the host name pg also sends as SNI.
    ssl: ssl ? { rejectUnauthorized: true } : false,
    enableChannelBinding: channelBinding,
    application_name: 'michael-router',
    max,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    allowExitOnIdle: true,
  });
  pool.on('error', noop); // an idle client that fails (server restart, network) is dropped by the pool
  onPool?.(pool);

  /**
   * Check out a client, run `fn` within the statement budget, release it (destroyed on any error).
   * @template T
   * @param {(client: pg.PoolClient) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function run(fn) {
    /** @type {pg.PoolClient} */
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      throw storeError('store connection failed', err);
    }
    client.on('error', noop); // pg-pool listens only while a client is idle
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new StoreError('store request timed out')), statementTimeoutMs);
    });
    const work = fn(client);
    work.catch(noop); // after a timeout its rejection is not needed
    try {
      const out = await Promise.race([work, late]);
      client.off('error', noop);
      client.release();
      return out;
    } catch (err) {
      client.off('error', noop);
      client.release(true);
      throw storeError('store query failed', err);
    } finally {
      clearTimeout(timer);
    }
  }

  /** @param {string} sql @param {unknown[]} params */
  const query = (sql, params) => run((client) => client.query(sql, params));

  return {
    kind: 'postgres',

    async ping() {
      const { rows } = await query(SQL.ping, []);
      const version = rows[0]?.version ?? null;
      if (version === null || int(version) < LATEST_SCHEMA_VERSION) throw new StoreError('store schema older than this router needs (run the migrations)');
      return { schemaVersion: int(version) };
    },

    async authPrecheck(source, nowMs) {
      const { rows } = await query(SQL.authPrecheck, [text(source), checkMs(nowMs), INFLIGHT_TTL_MS]);
      const r = rows[0];
      if (!r || !r.keys || typeof r.keys !== 'object' || Array.isArray(r.keys)) throw new StoreError('malformed store row');
      return {
        blockUntilMs: intOrNull(r.block_until_ms),
        waitUntilMs: intOrNull(r.wait_until_ms),
        failures: int(r.failures),
        inflight: int(r.inflight),
        keys: r.keys,
      };
    },

    async authRelease(source, nowMs) {
      await query(SQL.authRelease, [text(source), checkMs(nowMs)]);
    },

    async authFailure(source, nowMs, { windowMs, maxFailures }) {
      const params = [text(source), checkMs(nowMs), checkMs(windowMs), checkMs(maxFailures), STRIKES_TTL_MS, SWEEP_LIMIT];
      const { rows } = await query(SQL.authFailure, params);
      if (!rows[0]) throw new StoreError('malformed store row');
      return { failures: int(rows[0].failures), strikes: intOrNull(rows[0].strikes) };
    },

    async authPenalty(source, nowMs, { waitUntilMs, blockUntilMs }) {
      checkMs(nowMs);
      if (waitUntilMs === null && blockUntilMs === null) return;
      const params = [text(source), waitUntilMs === null ? null : checkMs(waitUntilMs), blockUntilMs === null ? null : checkMs(blockUntilMs)];
      await query(SQL.authPenalty, params);
    },

    async setProviderKey(provider, record, updatedAtIso) {
      await query(SQL.setProviderKey, [text(provider), text(record), text(updatedAtIso)]);
    },

    async deleteProviderKey(provider) {
      const r = await query(SQL.deleteProviderKey, [text(provider)]);
      return (r.rowCount ?? 0) > 0;
    },

    async addUsage(day, entries, { retainFromDay }) {
      checkDay(day);
      checkDay(retainFromDay);
      checkUsageEntries(entries);
      if (entries.length === 0) return;
      await query(SQL.addUsage, [
        day,
        retainFromDay,
        entries.map((e) => e.provider),
        entries.map((e) => e.model),
        entries.map((e) => e.metric),
        entries.map((e) => String(e.value)),
      ]);
    },

    async readUsage(fromDay, toDay) {
      const { rows } = await query(SQL.readUsage, [checkDay(fromDay), checkDay(toDay)]);
      // A total beyond 2^53 - 1 converts to an unsafe number, which aggregation skips like any
      // malformed counter.
      return rows.map((r) => ({ day: r.day, provider: r.provider, model: r.model, metric: r.metric, value: Number(r.value) }));
    },

    async appendEvent(json, max) {
      checkMs(max);
      await run(async (client) => {
        await client.query(SQL.appendEvent, [text(json)]);
        await client.query(SQL.trimEvents, [max]);
      });
    },

    async listEvents(max) {
      const { rows } = await query(SQL.listEvents, [checkMs(max)]);
      return rows.map((r) => String(r.event));
    },

    async close() {
      await pool.end();
    },
  };
}
