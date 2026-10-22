// Task-local PostgreSQL for tests: one throwaway cluster per test file, never a shared or remote
// server. The binaries come from PG_BIN, else PATH. initdb runs in a mkdtemp directory with trust
// auth for the superuser over the socket and scram-sha-256 for every other role; the server
// listens on a unix socket in that directory only (no TCP), with fsync, full-page writes and
// synchronous commit off. A small sh guard owns the server: when stop() is called, or this process
// exits and its end of the guard's stdin closes, the guard stops postgres and deletes the
// directory, so no cluster outlives its test file.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, constants, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { parseDatabaseUrl } from '../../src/store/database-url.js';
import { applyMigrations } from '../../src/store/migrate.js';

const STARTUP_MS = 30_000;
const NAME = /^[a-z][a-z0-9_]{0,40}$/;

// $1 = the cluster directory, the rest = the postgres command. The watcher subshell turns "stdin
// closed" into a fast shutdown; the guard waits for postgres to exit, then deletes the directory.
// Without job control sh gives a background command /dev/null as its stdin, so the watcher reads
// the guard's stdin through fd 3; and a background command starts with SIGINT ignored until
// postgres installs its handlers, so the watcher repeats the signal until postgres is gone.
const GUARD = `dir=$1; shift
exec 3<&0
"$@" </dev/null 3<&- &
pid=$!
( cat >/dev/null; while kill -INT "$pid" 2>/dev/null; do sleep 0.2; done ) <&3 3<&- &
watcher=$!
exec 3<&-
trap '' INT TERM HUP
wait "$pid"
status=$?
kill "$watcher" 2>/dev/null
rm -rf "$dir"
exit $status`;

/** @param {string} name */
async function findBinary(name) {
  const pgBin = process.env.PG_BIN;
  const dirs = pgBin ? [pgBin] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const file = path.join(dir, name);
    try {
      await access(file, constants.X_OK);
      return file;
    } catch {
      // try the next directory
    }
  }
  throw new Error(
    pgBin
      ? `PostgreSQL's ${name} is not in PG_BIN (${pgBin}). Set PG_BIN to the directory holding initdb and postgres.`
      : `PostgreSQL's ${name} is not on PATH. Install the PostgreSQL server binaries or set PG_BIN to the directory holding initdb and postgres.`,
  );
}

/** @param {string} file @param {string[]} args */
function run(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.once('error', reject);
    child.once('exit', (code, signal) => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(file)} failed (${code ?? signal}): ${out.trim()}`))));
  });
}

/** A password generated for one test database. */
export const generatedPassword = () => `db-pw-SENTINEL-${randomBytes(9).toString('hex')}`;

/**
 * Connect one pg Client, run `fn`, close it.
 * @template T
 * @param {string} url
 * @param {(client: pg.Client) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withClient(url, fn) {
  const client = new pg.Client({ connectionString: url });
  client.on('error', () => {}); // a server stopping under an open test client
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/** @param {string} url */
export const migrate = (url) => withClient(url, (client) => applyMigrations(client));

/** The store configuration src/config.js builds for this URL (development: no TLS on the socket). @param {string} url */
export function storeConfig(url) {
  const config = parseDatabaseUrl(url, { production: false });
  if (!config) throw new Error('the test database URL was refused');
  return config;
}

/**
 * Every row of every table in schema michael_router, as JSON text per table.
 * @param {string} url
 * @returns {Promise<Record<string, string[]>>}
 */
export function dumpRouterTables(url) {
  return withClient(url, async (client) => {
    const { rows: tables } = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'michael_router' ORDER BY table_name",
    );
    /** @type {Record<string, string[]>} */
    const out = {};
    for (const { table_name: name } of tables) {
      const { rows } = await client.query(`SELECT row_to_json(t)::text AS row FROM michael_router.${client.escapeIdentifier(name)} t ORDER BY 1`);
      out[name] = rows.map((r) => r.row);
    }
    return out;
  });
}

/**
 * Start a throwaway cluster.
 * @returns {Promise<{url: string, dir: string, createDatabase: (name: string, options?: {password?: string}) => Promise<string>,
 *   stop: () => Promise<void>, output: () => string}>}
 */
export async function startPostgres() {
  const [initdb, postgres] = [await findBinary('initdb'), await findBinary('postgres')];
  const dir = await mkdtemp(path.join(tmpdir(), 'mr-pg-'));
  const data = path.join(dir, 'data');
  try {
    await run(initdb, ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-locale', '--no-sync', '--no-instructions']);
    await writeFile(path.join(data, 'pg_hba.conf'), 'local all postgres trust\nlocal all all scram-sha-256\n');
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  const args = ['-D', data, '-k', dir, '-c', 'listen_addresses=', '-c', 'fsync=off', '-c', 'full_page_writes=off', '-c', 'synchronous_commit=off', '-c', 'max_connections=60'];
  const guard = spawn('/bin/sh', ['-c', GUARD, 'pg-guard', dir, postgres, ...args], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  guard.stdin.on('error', () => {}); // the guard already exited (postgres died)
  let log = '';
  guard.stderr.setEncoding('utf8');
  guard.stderr.on('data', (d) => {
    log = (log + d).slice(-16_384); // always drained, so postgres never blocks on a full pipe
  });
  const exited = new Promise((resolve) => guard.once('exit', resolve));
  const host = encodeURIComponent(dir);
  /** @param {string} user @param {string | null} password @param {string} db */
  const urlFor = (user, password, db) =>
    `postgresql://${user}${password === null ? '' : `:${encodeURIComponent(password)}`}@localhost/${db}?host=${host}`;
  const url = urlFor('postgres', null, 'postgres');

  let stopped = false;
  async function stop() {
    if (!stopped) {
      stopped = true;
      guard.stdin.end();
    }
    await exited;
  }

  const deadline = Date.now() + STARTUP_MS;
  for (;;) {
    if (guard.exitCode !== null) throw new Error(`postgres exited during startup: ${log.trim()}`);
    try {
      await withClient(url, (c) => c.query('SELECT 1'));
      break;
    } catch (err) {
      if (Date.now() > deadline) {
        await stop();
        throw new Error(`postgres did not accept connections within ${STARTUP_MS} ms: ${log.trim()}`, { cause: err });
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  return {
    url,
    dir,
    /**
     * A fresh database owned by a new non-superuser role of the same name (like a Neon project
     * role: it may create schemas in its database), with a password. Returns its URL.
     */
    async createDatabase(name, { password = generatedPassword() } = {}) {
      if (!NAME.test(name)) throw new Error(`invalid test database name ${name}`);
      await withClient(url, async (c) => {
        await c.query(`CREATE ROLE ${name} LOGIN PASSWORD ${c.escapeLiteral(password)}`);
        await c.query(`CREATE DATABASE ${name} OWNER ${name}`);
      });
      return urlFor(name, password, name);
    },
    stop,
    output: () => log,
  };
}
