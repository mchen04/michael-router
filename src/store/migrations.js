// Schema migrations for the Postgres store (DESIGN §2). Frozen and append-only: an applied
// migration's SQL never changes (its sha256 is recorded and checked), and every statement is
// additive (test/integration/migrations.test.js), so an upgrade keeps all router rows and nothing
// outside schema michael_router is ever touched. The router only reads schema_migrations
// (ping); it never migrates at request time.
//
// Times are epoch milliseconds from the router's clock (bigint). A limiter field is active while
// its end time is later than now; expires_ms is at least every end time in the row, so a row with
// expires_ms < now holds nothing active (authFailure sweeps such rows; see src/store/postgres.js).

/** @typedef {{version: number, name: string, sql: string}} Migration */

/** @type {readonly Readonly<Migration>[]} */
export const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: 'initial schema',
    sql: `CREATE SCHEMA IF NOT EXISTS michael_router;

CREATE TABLE IF NOT EXISTS michael_router.schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS michael_router.auth_sources (
  source text PRIMARY KEY,
  failures integer NOT NULL DEFAULT 0,
  failures_until_ms bigint NOT NULL DEFAULT 0,
  wait_until_ms bigint NOT NULL DEFAULT 0,
  block_until_ms bigint NOT NULL DEFAULT 0,
  strikes integer NOT NULL DEFAULT 0,
  strikes_until_ms bigint NOT NULL DEFAULT 0,
  inflight integer NOT NULL DEFAULT 0,
  inflight_until_ms bigint NOT NULL DEFAULT 0,
  expires_ms bigint NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS auth_sources_expires_ms_idx ON michael_router.auth_sources (expires_ms);

CREATE TABLE IF NOT EXISTS michael_router.provider_keys (
  provider text PRIMARY KEY,
  record text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS michael_router.usage_daily (
  day date,
  provider text,
  model text,
  metric text,
  value bigint NOT NULL,
  PRIMARY KEY (day, provider, model, metric)
);

CREATE TABLE IF NOT EXISTS michael_router.events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event json NOT NULL
);

COMMENT ON TABLE michael_router.auth_sources IS 'Wrong-password limiter state per source; end times are epoch ms';
COMMENT ON TABLE michael_router.provider_keys IS 'Provider key overrides, AES-256-GCM records only';
COMMENT ON TABLE michael_router.usage_daily IS 'Usage counters per UTC day, kept 400 days';
COMMENT ON TABLE michael_router.events IS 'Recent auth and error events, allowlisted metadata only';
`,
  }),
]);

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
