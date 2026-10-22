// Migrations on a task-local cluster, each case on a fresh database owned by a non-superuser role:
// fresh and repeated applies, read-only planning, data outside michael_router left untouched,
// router rows kept across an additive upgrade, the three refusals, concurrent runners, and a static
// check that every migration statement is additive and confined to schema michael_router.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { MigrationRefusedError, applyMigrations, migrationChecksum, planMigrations } from '../../src/store/migrate.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../../src/store/migrations.js';
import { createPostgresStore } from '../../src/store/postgres.js';
import { dumpRouterTables, migrate, startPostgres, storeConfig, withClient } from '../helpers/postgres.js';

/** @type {Awaited<ReturnType<typeof startPostgres>>} */
let cluster;
before(async () => {
  cluster = await startPostgres();
});
after(async () => {
  await cluster?.stop();
});

/** A test-only additive migration 2. */
const V2 = Object.freeze({
  version: 2,
  name: 'test: event note',
  sql: 'ALTER TABLE michael_router.events ADD COLUMN IF NOT EXISTS note text;\nCREATE INDEX IF NOT EXISTS events_note_idx ON michael_router.events (note);\n',
});

const USER_SCHEMAS = "n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'";

/**
 * Catalog and row digest of the database: schemas, relations, columns, functions, extensions,
 * the database's owner and ACL, and every user table's rows. With `outside`, schema
 * michael_router is left out.
 * @param {import('pg').Client} c @param {{outside?: boolean}} [options]
 */
async function digest(c, { outside = false } = {}) {
  const skip = outside ? "AND n.nspname <> 'michael_router'" : '';
  const { rows: catalog } = await c.query(`
    SELECT 'schema' AS kind, n.nspname AS name, pg_get_userbyid(n.nspowner) AS detail, coalesce(n.nspacl::text, '') AS extra
      FROM pg_namespace n WHERE true ${skip}
    UNION ALL SELECT 'relation', n.nspname || '.' || c.relname, c.relkind::text, coalesce(c.relacl::text, '') || pg_get_userbyid(c.relowner)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${USER_SCHEMAS} ${skip}
    UNION ALL SELECT 'column', n.nspname || '.' || c.relname || '.' || a.attname, format_type(a.atttypid, a.atttypmod),
        a.attnotnull::text || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attnum > 0 AND NOT a.attisdropped AND ${USER_SCHEMAS} ${skip}
    UNION ALL SELECT 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', md5(p.prosrc), ''
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ${USER_SCHEMAS} ${skip}
    UNION ALL SELECT 'extension', e.extname, e.extversion, '' FROM pg_extension e
    UNION ALL SELECT 'database', d.datname, pg_get_userbyid(d.datdba), coalesce(d.datacl::text, '')
      FROM pg_database d WHERE d.datname = current_database()
    ORDER BY 1, 2, 3, 4`);
  const { rows: tables } = await c.query(
    `SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r' AND ${USER_SCHEMAS} ${skip} ORDER BY 1, 2`,
  );
  /** @type {Record<string, string>} */
  const data = {};
  for (const t of tables) {
    const name = `${c.escapeIdentifier(t.schema)}.${c.escapeIdentifier(t.name)}`;
    const { rows } = await c.query(`SELECT coalesce(md5(string_agg(t::text, E'\\n' ORDER BY t::text)), '') AS d FROM ${name} t`);
    data[`${t.schema}.${t.name}`] = rows[0].d;
  }
  return JSON.stringify({ catalog, data });
}

/** @param {import('pg').Client} c */
const routerTables = async (c) =>
  (await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'michael_router' ORDER BY 1")).rows.map((r) => r.table_name);

/** @param {import('pg').Client} c */
const recorded = async (c) =>
  (await c.query('SELECT version, name, checksum FROM michael_router.schema_migrations ORDER BY version')).rows;

test('fresh apply creates the schema at the latest version; a re-apply changes nothing', async () => {
  const url = await cluster.createDatabase('fresh');
  await withClient(url, async (c) => {
    const plan = await planMigrations(c);
    assert.match(plan.serverVersion, /^\d+\.\d+/);
    assert.deepEqual([plan.schemaExists, plan.applied, plan.pending.map((p) => p.version), plan.refusal], [false, [], MIGRATIONS.map((m) => m.version), null]);
    assert.deepEqual((await applyMigrations(c)).applied, MIGRATIONS.map((m) => m.version));
    assert.deepEqual(await routerTables(c), ['auth_sources', 'events', 'provider_keys', 'schema_migrations', 'usage_daily']);
    assert.deepEqual(await recorded(c), MIGRATIONS.map((m) => ({ version: m.version, name: m.name, checksum: migrationChecksum(m.sql) })));
    const before = await digest(c);
    const again = await applyMigrations(c);
    assert.deepEqual([again.applied, again.plan.pending, again.plan.refusal], [[], [], null]);
    assert.equal(await digest(c), before, 'a re-apply changes nothing');
  });
  const store = createPostgresStore(storeConfig(url));
  try {
    assert.deepEqual(await store.ping(), { schemaVersion: LATEST_SCHEMA_VERSION });
  } finally {
    await store.close();
  }
});

test('check mode (planMigrations) is read-only and creates nothing on a fresh database', async () => {
  const url = await cluster.createDatabase('check_mode');
  await withClient(url, async (c) => {
    const before = await digest(c);
    /** @type {string[]} */
    const statements = [];
    const query = c.query.bind(c);
    /** @type {any} */ (c).query = (/** @type {any} */ sql, /** @type {any} */ ...rest) => {
      statements.push(String(sql).trim().split('\n')[0]);
      return query(sql, ...rest);
    };
    const plan = await planMigrations(c);
    /** @type {any} */ (c).query = query;
    assert.deepEqual([plan.schemaExists, plan.pending.length, plan.refusal], [false, MIGRATIONS.length, null]);
    assert.deepEqual([statements[0], statements.at(-1)], ['BEGIN READ ONLY', 'COMMIT']);
    assert.equal(await digest(c), before);
  });
});

test('data outside michael_router is never touched, even with a search_path that points elsewhere', async () => {
  const url = await cluster.createDatabase('existing');
  await withClient(url, (c) =>
    c.query(`
      CREATE TABLE public.notes (id integer PRIMARY KEY, body text NOT NULL DEFAULT '');
      INSERT INTO public.notes VALUES (1, 'kept'), (2, 'also kept');
      CREATE TABLE public.schema_migrations (version integer PRIMARY KEY, checksum text);
      INSERT INTO public.schema_migrations VALUES (99, 'not the router''s');
      CREATE VIEW public.note_count AS SELECT count(*) AS n FROM public.notes;
      CREATE SCHEMA app;
      CREATE TABLE app.events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, event json);
      INSERT INTO app.events (event) VALUES ('{"a": 1}'), ('{"b": 2}');
      CREATE TABLE app.auth_sources (source text PRIMARY KEY);
      CREATE FUNCTION app.answer() RETURNS integer LANGUAGE sql AS 'SELECT 42';
      ALTER DATABASE existing SET search_path = app, public;`),
  );
  const outside = () => withClient(url, (c) => digest(c, { outside: true }));
  const before = await outside();
  assert.deepEqual((await migrate(url)).applied, MIGRATIONS.map((m) => m.version));
  assert.equal(await outside(), before);
  await withClient(url, async (c) => assert.deepEqual(await routerTables(c), ['auth_sources', 'events', 'provider_keys', 'schema_migrations', 'usage_daily']));
});

test('router rows survive a re-apply and an additive migration 2', async () => {
  const url = await cluster.createDatabase('upgrade');
  await migrate(url);
  const store = createPostgresStore(storeConfig(url));
  try {
    const now = Date.parse('2026-10-21T12:00:00Z');
    await store.authFailure('kept-source', now, { windowMs: 600_000, maxFailures: 5 });
    await store.setProviderKey('claude', '{"v":1,"iv":"x","ct":"y","tag":"z"}', '2026-10-21T12:00:00.000Z');
    await store.addUsage('2026-10-21', [{ provider: 'claude', model: 'claude-haiku-5-5', metric: 'requests', value: 3 }], { retainFromDay: '2025-09-17' });
    await store.appendEvent('{"kind":"auth","kept":true}', 200);
    const before = await dumpRouterTables(url);
    await migrate(url);
    assert.deepEqual(await dumpRouterTables(url), before, 'a re-apply keeps every row');

    assert.deepEqual(additiveViolations(V2.sql), []);
    assert.deepEqual((await withClient(url, (c) => applyMigrations(c, [...MIGRATIONS, V2]))).applied, [2]);
    const upgraded = await dumpRouterTables(url);
    for (const table of ['auth_sources', 'provider_keys', 'usage_daily']) assert.deepEqual(upgraded[table], before[table], table);
    assert.deepEqual(
      upgraded.events.map((r) => JSON.parse(r)),
      before.events.map((r) => ({ ...JSON.parse(r), note: null })),
      'events gained only the new column',
    );
    assert.deepEqual(upgraded.schema_migrations.map((r) => JSON.parse(r).version), [1, 2]);
    assert.deepEqual(await store.ping(), { schemaVersion: 2 }, 'a newer additive schema still serves this router');
    assert.deepEqual(await store.listEvents(200), ['{"kind":"auth","kept":true}']);
  } finally {
    await store.close();
  }
});

test('refusals change nothing: objects without schema_migrations, an unknown applied version, a changed checksum', async () => {
  /**
   * @param {string} url @param {readonly any[]} migrations @param {RegExp} reason
   */
  const refused = (url, migrations, reason) =>
    withClient(url, async (c) => {
      const before = await digest(c);
      assert.match(String((await planMigrations(c, migrations)).refusal), reason);
      await assert.rejects(applyMigrations(c, migrations), (err) => err instanceof MigrationRefusedError && reason.test(err.message));
      assert.equal(await digest(c), before);
    });

  const foreign = await cluster.createDatabase('refuse_objects');
  await withClient(foreign, (c) => c.query('CREATE SCHEMA michael_router; CREATE TABLE michael_router.mine (id integer)'));
  await refused(foreign, MIGRATIONS, /already holds objects but has no schema_migrations/);

  const empty = await cluster.createDatabase('refuse_none');
  await withClient(empty, (c) => c.query('CREATE SCHEMA michael_router'));
  assert.deepEqual((await migrate(empty)).applied, [1], 'an empty pre-created schema is not a refusal');

  const newer = await cluster.createDatabase('refuse_newer');
  await withClient(newer, (c) => applyMigrations(c, [...MIGRATIONS, V2]));
  await refused(newer, MIGRATIONS, /records migration 2, which this code does not know/);

  const edited = await cluster.createDatabase('refuse_checksum');
  await migrate(edited);
  await refused(edited, [{ ...MIGRATIONS[0], sql: `${MIGRATIONS[0].sql}\n` }], /checksum of migration 1 differs/);
});

test('concurrent runners: each version is applied exactly once', async () => {
  const url = await cluster.createDatabase('concurrent');
  const runs = await Promise.all(Array.from({ length: 4 }, () => withClient(url, (c) => applyMigrations(c, [...MIGRATIONS, V2]))));
  assert.deepEqual(runs.flatMap((r) => r.applied).sort(), [1, 2]);
  await withClient(url, async (c) => assert.deepEqual((await recorded(c)).map((r) => r.version), [1, 2]));
});

// Static additive-only check. Allowed statements create in, or comment on, schema michael_router
// only, idempotently; everything else is refused, including anything that removes, rewrites,
// grants or names another schema. Deliberately strict: a migration that needs more updates this.
const ID = '[a-z_][a-z0-9_]*';
const OURS = `michael_router\\.${ID}`;
const ALLOWED = [
  /^CREATE SCHEMA IF NOT EXISTS michael_router$/i,
  new RegExp(`^CREATE TABLE IF NOT EXISTS ${OURS} \\((.+)\\)$`, 'i'),
  new RegExp(`^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ${ID} ON ${OURS} (?:USING ${ID} )?\\((.+)\\)$`, 'i'),
  new RegExp(`^ALTER TABLE ${OURS} ADD COLUMN IF NOT EXISTS (.+)$`, 'i'),
  new RegExp(`^COMMENT ON (?:TABLE|COLUMN|INDEX) ${OURS}(?:\\.${ID})? IS '(?:[^']|'')*'$`, 'i'),
];
const BODY_REFUSED = /\b(?:ADD|ALTER|AS\s+SELECT|CASCADE|DELETE|DROP|EXECUTE|GRANT|INHERITS|INSERT|LIKE|PARTITION|RENAME|REPLACE|REVOKE|SELECT|SET|TABLESPACE|TRUNCATE|TYPE|UPDATE|WITH)\b/i;

/** Split on semicolons outside single-quoted strings (the only quoting the check allows). @param {string} sql */
function statements(sql) {
  const out = [''];
  let quoted = false;
  for (const ch of sql) {
    if (ch === "'") quoted = !quoted;
    if (ch === ';' && !quoted) out.push('');
    else out[out.length - 1] += ch;
  }
  if (quoted) throw new Error('unterminated string');
  return out;
}

/** @param {string} sql @returns {string[]} the statements that are not allowed */
function additiveViolations(sql) {
  if (/--|\/\*|\$|"/.test(sql)) return ['comments, dollar quoting and quoted identifiers are refused'];
  return statements(sql)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((statement) => {
      const m = ALLOWED.map((re) => re.exec(statement)).find(Boolean);
      if (!m) return true;
      const body = m[1] ?? '';
      if (BODY_REFUSED.test(body) || /\bREFERENCES\s+(?!michael_router\.)/i.test(body)) return true;
      return [...body.matchAll(/\b([a-z_][a-z0-9_]*)\s*\.\s*[a-z_]/gi)].some((q) => q[1].toLowerCase() !== 'michael_router');
    });
}

test('every migration is additive and confined to michael_router (static check); the check refuses everything else', () => {
  for (const m of MIGRATIONS) assert.deepEqual(additiveViolations(m.sql), [], `migration ${m.version}`);
  assert.deepEqual(
    MIGRATIONS.map((m) => m.version),
    MIGRATIONS.map((_, i) => i + 1),
    'versions are 1..n in order',
  );
  assert.ok(Object.isFrozen(MIGRATIONS) && MIGRATIONS.every((m) => Object.isFrozen(m)));
  for (const ok of [
    V2.sql,
    'CREATE TABLE IF NOT EXISTS michael_router.t (id integer PRIMARY KEY, parent bigint REFERENCES michael_router.events (id))',
    'CREATE UNIQUE INDEX IF NOT EXISTS t_parent_idx ON michael_router.t (parent)',
    "COMMENT ON COLUMN michael_router.events.note IS 'it''s optional'",
  ]) {
    assert.deepEqual(additiveViolations(ok), [], ok);
  }
  for (const bad of [
    'DROP TABLE michael_router.events',
    'DROP TABLE IF EXISTS michael_router.events',
    'TRUNCATE michael_router.events',
    'DELETE FROM michael_router.events',
    "UPDATE michael_router.provider_keys SET record = ''",
    'INSERT INTO michael_router.events (event) VALUES (null)',
    'ALTER TABLE michael_router.events RENAME TO events_old',
    'ALTER TABLE michael_router.events RENAME COLUMN event TO payload',
    'ALTER TABLE michael_router.events ALTER COLUMN event TYPE jsonb',
    'ALTER TABLE michael_router.events ALTER COLUMN event SET DEFAULT null',
    'ALTER TABLE michael_router.events DROP COLUMN event',
    'ALTER TABLE michael_router.events ADD COLUMN note text',
    'ALTER TABLE michael_router.events ADD COLUMN IF NOT EXISTS note text, DROP COLUMN event',
    'ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS note text',
    'GRANT SELECT ON michael_router.events TO PUBLIC',
    'REVOKE ALL ON michael_router.events FROM PUBLIC',
    'CREATE OR REPLACE FUNCTION michael_router.f() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$',
    'CREATE OR REPLACE VIEW michael_router.v AS SELECT 1',
    'CREATE EXTENSION IF NOT EXISTS pgcrypto',
    'CREATE SCHEMA IF NOT EXISTS app',
    'CREATE SCHEMA michael_router',
    'CREATE TABLE michael_router.t (id integer)',
    'CREATE TABLE IF NOT EXISTS public.t (id integer)',
    'CREATE TABLE IF NOT EXISTS t (id integer)',
    'CREATE TABLE IF NOT EXISTS michael_router."Events" (id integer)',
    'CREATE TABLE IF NOT EXISTS michael_router.t (id integer REFERENCES public.notes (id))',
    'CREATE TABLE IF NOT EXISTS michael_router.t (id integer REFERENCES notes (id))',
    'CREATE TABLE IF NOT EXISTS michael_router.t (id integer) INHERITS (notes)',
    'CREATE TABLE IF NOT EXISTS michael_router.t AS SELECT * FROM public.notes',
    'CREATE INDEX IF NOT EXISTS i ON public.notes (id)',
    'CREATE INDEX i ON michael_router.events (id)',
    "COMMENT ON TABLE public.notes IS 'x'",
    "COMMENT ON TABLE michael_router.events IS 'a'; DROP TABLE michael_router.events",
    'SET search_path = public',
    '-- note\nCREATE SCHEMA IF NOT EXISTS michael_router',
  ]) {
    assert.notDeepEqual(additiveViolations(bad), [], bad);
  }
});
