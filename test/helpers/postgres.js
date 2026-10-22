// Task-local PostgreSQL for tests: one throwaway cluster per test file, never a shared or remote
// server. The binaries come from PG_BIN, else PATH. initdb runs in a mkdtemp directory under
// os.tmpdir() with trust auth for the superuser over the socket and scram-sha-256 for every other
// role; the server listens on a unix socket only (no TCP), with fsync, full-page writes and
// synchronous commit off. The socket goes in the same directory when its path fits in a unix
// socket address. Under a long TMPDIR it does not; then MR_TEST_SOCKET_ROOT, a test-only setting
// read only here, must name a short directory the tester owns (absolute, existing, not resolving
// under /tmp, /private/tmp or /var/tmp), and the socket gets a second private mkdtemp directory
// there. Without it the helper throws: there is no fallback, and nothing goes to /tmp unless
// TMPDIR points there. Both directories are named mr-pg-*. A small sh guard owns the server: when
// stop() is called, or this process exits and its end of the guard's stdin closes, the guard stops
// postgres and deletes both directories, so no cluster outlives its test file.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, constants, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { parseDatabaseUrl } from '../../src/store/database-url.js';
import { applyMigrations } from '../../src/store/migrate.js';

const STARTUP_MS = 30_000;
const NAME = /^[a-z][a-z0-9_]{0,40}$/;
const PREFIX = 'mr-pg-';
/** The server's port. It names the socket file (.s.PGSQL.<port>); the URLs leave it implicit. */
const PORT = 5432;
// A unix socket path must fit in sockaddr_un.sun_path, which counts the terminating NUL: 104 bytes
// on macOS, 108 on Linux. The smaller limit applies everywhere, so a path that fits here fits on both.
const SOCKET_PATH_BYTES = 104;
/** System temp roots a socket root may not resolve under (on macOS /tmp and /var/tmp live in /private). */
const SYSTEM_TEMP_ROOTS = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'];

/** Whether the socket file in `dir` fits in a unix socket address. @param {string} dir @param {number} [limit] */
const socketFits = (dir, limit = SOCKET_PATH_BYTES) => Buffer.byteLength(path.join(dir, `.s.PGSQL.${PORT}`)) < limit;
/** The longest socket directory mkdtemp can make under `root` (it appends six characters to the prefix). @param {string} root */
const socketDirIn = (root) => path.join(root, `${PREFIX}XXXXXX`);
/** @param {string} p */
const systemTempRoot = (p) => SYSTEM_TEMP_ROOTS.find((r) => p === r || p.startsWith(`${r}/`));

/**
 * The directory under which a socket directory goes; reads the filesystem, creates nothing.
 * `tmpdir` when a socket directory under it fits (for a cluster, the socket then stays in the
 * cluster directory); else `socketRoot` (MR_TEST_SOCKET_ROOT), resolved with realpath, which must
 * be an absolute path to an existing directory that is not under a system temp root and in which
 * a socket directory fits. Throws otherwise; there is no other fallback.
 * @param {{tmpdir: string, socketRoot?: string, limit?: number}} options `limit` is for tests only.
 * @returns {Promise<string>}
 */
export async function socketRootFor({ tmpdir, socketRoot, limit = SOCKET_PATH_BYTES }) {
  if (socketFits(socketDirIn(tmpdir), limit)) return tmpdir;
  const over = `the PostgreSQL socket path under TMPDIR (${path.join(socketDirIn(tmpdir), `.s.PGSQL.${PORT}`)}) is over the unix socket path limit of ${limit} bytes with the NUL`;
  const own = `a short directory you own (an absolute path to an existing directory, not under ${SYSTEM_TEMP_ROOTS.join(', ')})`;
  if (!socketRoot) throw new Error(`${over}. Set MR_TEST_SOCKET_ROOT to ${own}.`);
  /** @param {string} why @param {ErrorOptions} [options] */
  const refused = (why, options) => new Error(`${over}, and MR_TEST_SOCKET_ROOT (${socketRoot}) ${why}. Set it to ${own}.`, options);
  if (!path.isAbsolute(socketRoot)) throw refused('is not an absolute path');
  const inTemp = systemTempRoot(path.normalize(socketRoot));
  if (inTemp) throw refused(`is under ${inTemp}`);
  let real;
  try {
    real = await realpath(socketRoot);
  } catch (err) {
    throw refused('does not exist', { cause: err });
  }
  if (!(await stat(real)).isDirectory()) throw refused('is not a directory');
  const realInTemp = systemTempRoot(real);
  if (realInTemp) throw refused(`resolves under ${realInTemp}`);
  if (!socketFits(socketDirIn(real), limit)) throw refused(`is too long as well (it resolves to ${real})`);
  return real;
}

/** A new private (0700) mr-pg- directory in which the socket fits: under os.tmpdir(), else MR_TEST_SOCKET_ROOT. */
async function makeSocketDir() {
  const root = await socketRootFor({ tmpdir: tmpdir(), socketRoot: process.env.MR_TEST_SOCKET_ROOT });
  const dir = await mkdtemp(path.join(root, PREFIX)); // mkdtemp makes it 0700
  if (!socketFits(dir)) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`the PostgreSQL socket path in ${dir} is over the unix socket path limit of ${SOCKET_PATH_BYTES} bytes with the NUL`);
  }
  return dir;
}

/**
 * A private directory with no server in it, whose socket path fits: connecting there fails with
 * ENOENT at any TMPDIR length (an address that is too long would fail with EINVAL instead).
 * @returns {Promise<{dir: string, remove: () => Promise<void>}>}
 */
export async function emptySocketDir() {
  const dir = await makeSocketDir();
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}

// $1 = the cluster directory, $2 = the socket directory (the same one, or a short one), the rest =
// the postgres command. The watcher subshell turns "stdin closed" into a fast shutdown; the guard
// waits for postgres to exit, then deletes both directories.
// Without job control sh gives a background command /dev/null as its stdin, so the watcher reads
// the guard's stdin through fd 3; and a background command starts with SIGINT ignored until
// postgres installs its handlers, so the watcher repeats the signal until postgres is gone.
const GUARD = `dir=$1; sockets=$2; shift 2
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
rm -rf "$dir" "$sockets"
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
 * @returns {Promise<{url: string, socketDir: string, createDatabase: (name: string, options?: {password?: string}) => Promise<string>,
 *   stop: () => Promise<void>, output: () => string}>}
 */
export async function startPostgres() {
  const [initdb, postgres] = [await findBinary('initdb'), await findBinary('postgres')];
  const dir = await mkdtemp(path.join(tmpdir(), PREFIX));
  const data = path.join(dir, 'data');
  let socketDir = dir;
  try {
    if (!socketFits(dir)) socketDir = await makeSocketDir();
    await run(initdb, ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-locale', '--no-sync', '--no-instructions']);
    await writeFile(path.join(data, 'pg_hba.conf'), 'local all postgres trust\nlocal all all scram-sha-256\n');
  } catch (err) {
    await Promise.all([dir, socketDir].map((d) => rm(d, { recursive: true, force: true })));
    throw err;
  }
  const args = ['-D', data, '-k', socketDir, '-p', String(PORT), '-c', 'listen_addresses=', '-c', 'fsync=off', '-c', 'full_page_writes=off', '-c', 'synchronous_commit=off', '-c', 'max_connections=60'];
  const guard = spawn('/bin/sh', ['-c', GUARD, 'pg-guard', dir, socketDir, postgres, ...args], {
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
  const host = encodeURIComponent(socketDir);
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
    socketDir,
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
