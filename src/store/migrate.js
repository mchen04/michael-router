// Migration planning and application (DESIGN §2), for the operator's migrate command and the tests.
// `client` is a connected pg Client (or a checked-out pool client) used for nothing else meanwhile.
// Only schema michael_router is ever read for router state or changed. Refusals change nothing:
//   1. the schema exists and holds objects but has no schema_migrations table;
//   2. the database records a migration version this code does not know (the database is newer);
//   3. a recorded checksum differs from the code's migration of that version.
import { createHash } from 'node:crypto';
import { MIGRATIONS } from './migrations.js';

const SCHEMA = 'michael_router';
/** pg_advisory_xact_lock key serializing migration runs ('mr-migr8' as a big-endian int64). */
export const MIGRATION_LOCK_KEY = '7886415845422232120';

export class MigrationRefusedError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'MigrationRefusedError';
  }
}

/** @param {string} sql */
export const migrationChecksum = (sql) => createHash('sha256').update(sql, 'utf8').digest('hex');

/**
 * @typedef {{serverVersion: string, schemaExists: boolean, applied: {version: number, checksum: string}[],
 *   pending: {version: number, name: string}[], refusal: string | null}} MigrationPlan
 */

/**
 * Read the state inside the caller's transaction.
 * @param {import('pg').ClientBase} client
 * @param {readonly import('./migrations.js').Migration[]} migrations
 * @returns {Promise<MigrationPlan>}
 */
async function readState(client, migrations) {
  const { rows } = await client.query(
    `SELECT current_setting('server_version') AS server_version,
       n.oid IS NOT NULL AS schema_exists,
       to_regclass('michael_router.schema_migrations') IS NOT NULL AS has_table,
       (SELECT count(*) FROM pg_catalog.pg_class c WHERE c.relnamespace = n.oid)
         + (SELECT count(*) FROM pg_catalog.pg_proc p WHERE p.pronamespace = n.oid)
         + (SELECT count(*) FROM pg_catalog.pg_type t WHERE t.typnamespace = n.oid AND t.typrelid = 0 AND t.typcategory <> 'A')
         AS objects
     FROM (SELECT 1) AS one LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = $1`,
    [SCHEMA],
  );
  const s = rows[0];
  /** @type {{version: number, checksum: string}[]} */
  let applied = [];
  if (s.has_table) {
    const r = await client.query('SELECT version, checksum FROM michael_router.schema_migrations ORDER BY version');
    applied = r.rows.map((row) => ({ version: Number(row.version), checksum: String(row.checksum) }));
  }
  const known = new Map(migrations.map((m) => [m.version, m]));
  let refusal = null;
  if (s.schema_exists && !s.has_table && Number(s.objects) > 0) {
    refusal = `schema ${SCHEMA} already holds objects but has no schema_migrations table`;
  } else {
    for (const a of applied) {
      const m = known.get(a.version);
      if (!m) {
        refusal = `the database records migration ${a.version}, which this code does not know (the database is newer)`;
        break;
      }
      if (migrationChecksum(m.sql) !== a.checksum) {
        refusal = `the recorded checksum of migration ${a.version} differs from this code's`;
        break;
      }
    }
  }
  const done = new Set(applied.map((a) => a.version));
  const pending = migrations.filter((m) => !done.has(m.version)).map((m) => ({ version: m.version, name: m.name }));
  return { serverVersion: String(s.server_version), schemaExists: Boolean(s.schema_exists), applied, pending, refusal };
}

/** @param {import('pg').ClientBase} client @param {string} begin @param {() => Promise<any>} fn */
async function inTransaction(client, begin, fn) {
  await client.query(begin);
  try {
    const out = await fn();
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * Read-only plan: what is applied and what would be.
 * @param {import('pg').ClientBase} client
 * @param {readonly import('./migrations.js').Migration[]} [migrations]
 * @returns {Promise<MigrationPlan>}
 */
export function planMigrations(client, migrations = MIGRATIONS) {
  return inTransaction(client, 'BEGIN READ ONLY', () => readState(client, migrations));
}

/**
 * Apply every pending migration, each in its own transaction under the advisory lock, re-reading
 * the applied versions under the lock (a concurrent run may have applied some meanwhile).
 * Throws MigrationRefusedError, having changed nothing, on a refusal.
 * @param {import('pg').ClientBase} client
 * @param {readonly import('./migrations.js').Migration[]} [migrations]
 * @returns {Promise<{applied: number[], plan: MigrationPlan}>} the versions this run applied
 */
export async function applyMigrations(client, migrations = MIGRATIONS) {
  const plan = await planMigrations(client, migrations);
  if (plan.refusal) throw new MigrationRefusedError(plan.refusal);
  /** @type {number[]} */
  const applied = [];
  for (const { version } of plan.pending) {
    const m = /** @type {import('./migrations.js').Migration} */ (migrations.find((x) => x.version === version));
    await inTransaction(client, 'BEGIN', async () => {
      // Timeouts first, so that waiting for the lock (or for a table lock) is bounded too.
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query("SET LOCAL statement_timeout = '60s'");
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
      const now = await readState(client, migrations);
      if (now.refusal) throw new MigrationRefusedError(now.refusal);
      if (now.applied.some((a) => a.version === m.version)) return;
      await client.query(m.sql);
      await client.query('INSERT INTO michael_router.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
        m.version,
        m.name,
        migrationChecksum(m.sql),
      ]);
      applied.push(m.version);
    });
  }
  return { applied, plan };
}
