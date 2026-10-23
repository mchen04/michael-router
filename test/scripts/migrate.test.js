// scripts/migrate.mjs against a task-local cluster: every database belongs to a non-superuser role
// with a generated password. The URL reaches the CLI on stdin only, and no part of it (the URL,
// user, password, database name or socket directory) may appear in any output.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXIT, main } from '../../scripts/migrate.mjs';
import { emptySocketDir, generatedPassword, startPostgres, withClient } from '../helpers/postgres.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/migrate.mjs', import.meta.url));
const MARKER = 'SENTINEL';

/** @type {Awaited<ReturnType<typeof startPostgres>>} */
let cluster;
/** A socket directory nobody serves. @type {Awaited<ReturnType<typeof emptySocketDir>>} */
let noServer;
let home = '';
let serverMajor = '';
before(async () => {
  cluster = await startPostgres();
  noServer = await emptySocketDir();
  home = await mkdtemp(path.join(os.tmpdir(), 'migrate-cli-home-'));
  serverMajor = await withClient(cluster.url, async (c) => String(Math.floor(Number((await c.query('SHOW server_version_num')).rows[0].server_version_num) / 10000)));
});
after(async () => {
  await cluster?.stop();
  await noServer?.remove();
  if (home) await rm(home, { recursive: true, force: true });
});

/**
 * @param {string[]} args @param {string} input @param {Record<string, string>} [env]
 * @returns {Promise<{code: number | null, stdout: string, stderr: string}>}
 */
function runMigrate(args, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`migrate.mjs timed out (stderr so far: ${stderr})`));
    }, 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * A URL for a database nobody serves: user and database `user`, a generated password.
 * @param {string} user @param {string} host @param {string} [socketDir] the `host=` socket directory
 */
function generatedUrl(user, host, socketDir) {
  const url = new URL(`postgresql://${host}/${user}`);
  url.username = user;
  url.password = generatedPassword();
  if (socketDir) url.searchParams.set('host', socketDir);
  return url.href;
}

/** The URL and every part of it, as written and decoded. @param {string} raw */
function urlParts(raw) {
  const url = new URL(raw);
  const parts = [raw, url.username, url.password, decodeURIComponent(url.password), url.pathname.slice(1), url.searchParams.get('host') ?? '', url.host];
  return parts.filter((p) => p.length >= 4 && p !== 'localhost');
}

/** @param {{stdout: string, stderr: string}} r @param {string[]} urls */
function assertNoUrlPart(r, urls) {
  const out = r.stdout + r.stderr;
  for (const part of [MARKER, ...urls.flatMap(urlParts)]) assert.ok(!out.includes(part), `a part of the URL reached the output: ${out}`);
}

/** @param {string} text */
const lines = (text) => text.split('\n').filter(Boolean);
const plan = (/** @type {string[]} */ rest) => [`PostgreSQL server major version: ${serverMajor}`, ...rest];

test('a fresh database: the plan exits 4 and creates nothing, --apply exits 0, then the plan exits 0', async () => {
  const url = await cluster.createDatabase('mr_cli_fresh');
  const input = `# database\nexport DATABASE_URL="${url}"\n`;
  const pending = await runMigrate([], input);
  assert.equal(pending.code, EXIT.PENDING, pending.stdout + pending.stderr);
  assert.deepEqual(lines(pending.stdout), plan(['Schema michael_router: does not exist', 'Applied migrations: none', 'Pending migrations: 1 (initial schema)', 'Refusal: none', 'Pending: run again with --apply to apply them.']));
  const created = await withClient(url, async (c) =>
    (await c.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')")).rows[0].n
    + (await c.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'michael_router'")).rows[0].n);
  assert.equal(created, 0, 'the plan created nothing');

  // PG* variables are ignored: with this one honored, every transaction would be read-only.
  const applied = await runMigrate(['--apply'], input, { PGOPTIONS: '-c default_transaction_read_only=on' });
  assert.equal(applied.code, EXIT.OK, applied.stdout + applied.stderr);
  assert.deepEqual(lines(applied.stdout), ['Applied migration 1 (initial schema)', ...plan(['Schema michael_router: exists', 'Applied migrations: 1', 'Pending migrations: none', 'Refusal: none', 'Up to date.'])]);

  for (const args of [[], ['--apply']]) {
    const again = await runMigrate(args, input);
    assert.equal(again.code, EXIT.OK, again.stdout + again.stderr);
    assert.match(again.stdout, /^Applied migrations: 1\nPending migrations: none\nRefusal: none\nUp to date\.$/m);
    if (args.length) assert.match(again.stdout, /^Nothing to apply\.$/m);
  }
  for (const r of [pending, applied]) assertNoUrlPart(r, [url]);
});

test('stdin forms: a dotenv document (--var picks the variable, quotes and comments) or one bare URL line', async () => {
  const url = await cluster.createDatabase('mr_cli_forms');
  const nowhere = generatedUrl('mr_cli_absent', 'localhost', noServer.dir);
  const doc = (/** @type {string} */ direct, /** @type {string} */ pooled) => `# comment\n\nDATABASE_URL='${direct}' # direct\nexport DATABASE_URL_POOLED="${pooled}"\nOTHER=x\n`;
  /** @type {[string[], string, number][]} */
  const cases = [
    [[], doc(url, nowhere), EXIT.PENDING], // the default variable is DATABASE_URL
    [['--var', 'DATABASE_URL_POOLED'], doc(url, nowhere), EXIT.ERROR], // the unreachable one
    [['--var=DATABASE_URL_POOLED'], doc(nowhere, url), EXIT.PENDING],
    [[], `${url}\n`, EXIT.PENDING],
    [[], `  ${url}  `, EXIT.PENDING],
  ];
  for (const [args, input, code] of cases) {
    const r = await runMigrate(args, input);
    assert.equal(r.code, code, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    if (code === EXIT.PENDING) assert.match(r.stdout, /^Pending migrations: 1 \(initial schema\)$/m);
    assertNoUrlPart(r, [url, nowhere]);
  }
});

test('usage errors exit 2, name the variable and never repeat a value', async () => {
  const url = await cluster.createDatabase('mr_cli_usage');
  const pw = generatedPassword();
  /** @type {[string[], string, RegExp][]} */
  const cases = [
    [[], '', /DATABASE_URL is not set in the dotenv document on stdin/],
    [['--var', 'MISSING_URL'], `DATABASE_URL=${url}\n`, /MISSING_URL is not set in the dotenv document on stdin/],
    [[], `DATABASE_URL=${url}\nDATABASE_URL=${url}\n`, /DATABASE_URL is set more than once/],
    [[], `DATABASE_URL=${url}\nnot a line ${pw}\n`, /line 2 is not a NAME=value line/],
    [[], `DATABASE_URL="${url}\n`, /DATABASE_URL \(line 1\) has a malformed quoted value/],
    [[], `DATABASE_URL=https://router:${pw}@db.example.invalid/router\n`, /DATABASE_URL is not a PostgreSQL URL the store accepts/],
    [[], `DATABASE_URL=postgresql://router:${pw}@db.example.invalid/router\n`, /DATABASE_URL is not a PostgreSQL URL the store accepts/], // remote without TLS
    [[], `postgresql://router:${pw}@db.example.invalid/router?sslmode=disable\n`, /the URL on stdin is not a PostgreSQL URL the store accepts/],
    [['--var', 'DATABASE_URL'], `${url}\n`, /--var DATABASE_URL names a dotenv variable, but stdin holds a bare URL/],
    [[], `DATABASE_URL=${url}\n#${'x'.repeat(64 * 1024)}\n`, /stdin holds more than 64 KiB/],
    [[url], '', /unexpected argument \(the URL is read from stdin, never from arguments\)/],
    [['--var', url], '', /--var needs a variable name/],
    [['--plan'], '', /unknown option --plan/],
  ];
  for (const [args, input, message] of cases) {
    const r = await runMigrate(args, input);
    assert.equal(r.code, EXIT.USAGE, `${message}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, message);
    assert.equal(r.stdout, '');
    assert.ok(!(r.stdout + r.stderr).includes(pw));
    assertNoUrlPart(r, [url]);
  }
  const fresh = await withClient(url, async (c) => (await c.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'michael_router'")).rows[0].n);
  assert.equal(fresh, 0, 'no usage error reached the database');
});

test('a refusal exits 3 in plan and apply mode and changes nothing', async () => {
  const url = await cluster.createDatabase('mr_cli_refused');
  await withClient(url, async (c) => {
    await c.query('CREATE SCHEMA michael_router');
    await c.query('CREATE TABLE michael_router.leftover (x integer)');
    await c.query('INSERT INTO michael_router.leftover VALUES (7)');
  });
  for (const args of [[], ['--apply']]) {
    const r = await runMigrate(args, `DATABASE_URL=${url}\n`);
    assert.equal(r.code, EXIT.REFUSED, `${args}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^Refusal: schema michael_router already holds objects but has no schema_migrations table$/m);
    assert.match(r.stdout, /^Refused: nothing was changed\./m);
    assertNoUrlPart(r, [url]);
  }
  const state = await withClient(url, async (c) => ({
    rows: (await c.query('SELECT x FROM michael_router.leftover')).rows.map((r) => r.x),
    migrations: (await c.query("SELECT to_regclass('michael_router.schema_migrations') IS NOT NULL AS t")).rows[0].t,
  }));
  assert.deepEqual(state, { rows: [7], migrations: false });
});

test('an unreachable server, a wrong password, TLS refused or a password only in PG* or ~/.pgpass: exit 1 with no part of the URL', async () => {
  const url = await cluster.createDatabase('mr_cli_login');
  const right = decodeURIComponent(new URL(url).password);
  const wrong = new URL(url);
  wrong.password = encodeURIComponent(generatedPassword());
  const noPassword = new URL(url);
  noPassword.password = '';
  const tls = new URL(url);
  tls.searchParams.set('sslmode', 'require');
  const gone = generatedUrl('mr_cli_gone', 'localhost', noServer.dir);
  const closedPort = generatedUrl('mr_cli_tcp', '127.0.0.1:1');
  await writeFile(path.join(home, '.pgpass'), `*:*:*:*:${right}\n`, { mode: 0o600 });
  try {
    /** @type {[string, Record<string, string>, RegExp][]} */
    const cases = [
      [gone, {}, /^migrate: could not connect to the database: error code ENOENT$/m],
      [closedPort, {}, /^migrate: could not connect to the database: error code ECONNREFUSED$/m],
      [wrong.href, {}, /^migrate: could not connect to the database: authentication failed \(SQLSTATE 28P01\)$/m],
      [noPassword.href, { PGPASSWORD: right }, /^migrate: could not connect to the database: authentication failed$/m],
      [tls.href, {}, /^migrate: could not connect to the database: the server does not offer TLS$/m],
    ];
    for (const [target, env, message] of cases) {
      const r = await runMigrate([], `DATABASE_URL=${target}\n`, env);
      assert.equal(r.code, EXIT.ERROR, `${message}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, message);
      assertNoUrlPart(r, [url, target]);
      assert.ok(!(r.stdout + r.stderr).includes(right));
    }
  } finally {
    await rm(path.join(home, '.pgpass'), { force: true });
  }
});

test('a terminal on stdin is refused before anything is read (exit 2)', async () => {
  const stdin = Object.assign(Readable.from([]), { isTTY: true });
  let out = '';
  let err = '';
  const code = await main([], { stdin, stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) } });
  assert.equal(code, EXIT.USAGE);
  assert.equal(out, '');
  assert.match(err, /^migrate: stdin is a terminal; pipe the value in \(it is never typed\)$/m);
});
