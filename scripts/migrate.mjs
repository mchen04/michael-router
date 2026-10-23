#!/usr/bin/env node
// Schema migrations for the Postgres store, run by whoever deploys (DEPLOY.md step 3.1), around
// src/store/migrate.js.
//
//   <dotenv document or URL> | node scripts/migrate.mjs [--var NAME] [--apply]
//
// The connection string comes from stdin only: either a dotenv document (scripts/lib/
// env-document.mjs), from which --var picks the variable (default DATABASE_URL: on Neon the direct
// endpoint, where DDL belongs), or one bare postgres:// or postgresql:// line. A terminal on stdin,
// more than 64 KiB, a malformed document, a variable set twice or missing, and a URL the store's
// own rules refuse (src/store/database-url.js: TLS unless the host is local) are usage errors that
// name the variable, never a value. PG* environment variables are ignored and no password file is
// read: the URL alone decides where to connect and how to log in. The connection uses the store's
// own TLS options (pgConnectionOptions).
//
// Modes:
//   (default)  read-only plan: the server's major version, whether schema michael_router exists,
//              the applied and pending versions, and any refusal reason. Nothing is changed.
//   --apply    apply the pending migrations, print each version applied, then plan again and print
//              the final state.
// Exit codes: 0 up to date (or applied), 4 pending (plan mode), 3 refused, 2 usage, 1 unexpected
// (including a database that cannot be reached or refuses the login).
//
// The output never contains the URL or any part of it (host, user, database, password): errors
// are fixed sentences with the SQLSTATE or the error code only, and every line is scrubbed of the
// URL and each of its parts.
import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { createRedactor } from '../src/redact.js';
import { databaseUrlSecrets, parseDatabaseUrl, pgConnectionOptions } from '../src/store/database-url.js';
import { MigrationRefusedError, applyMigrations, planMigrations } from '../src/store/migrate.js';
import { parseEnvDocument, readStdin } from './lib/env-document.mjs';

export const EXIT = Object.freeze({ OK: 0, ERROR: 1, USAGE: 2, REFUSED: 3, PENDING: 4 });
const DEFAULT_VAR = 'DATABASE_URL';
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const BARE_URL = /^postgres(?:ql)?:\/\//;
const CONNECT_TIMEOUT_MS = 15_000; // a Neon compute that scaled to zero takes about a second to wake
const QUERY_TIMEOUT_MS = 120_000; // client-side backstop; apply also sets lock and statement timeouts
const SCHEMA = 'michael_router';

const USAGE = `usage: <dotenv document or URL> | node scripts/migrate.mjs [--var NAME] [--apply]

The database URL is read from stdin only: a dotenv document (--var picks the variable,
default ${DEFAULT_VAR}) or one postgres:// line. Without --apply the plan is printed and nothing
is changed. See docs/DEPLOY.md step 3.`;

class UsageError extends Error {}

/** SQLSTATE classes (or exact codes) worth a sentence; anything else is "server error". */
const SQLSTATE_TEXT = [
  ['28', 'authentication failed'],
  ['3D', 'the database does not exist'],
  ['42501', 'insufficient privilege'],
  ['55P03', 'a lock was not available in time (another migration may be running)'],
  ['57014', 'a statement timed out or was canceled'],
  ['57P', 'the server is shutting down or restarting'],
  ['53', 'the server is out of resources'],
  ['08', 'connection failure'],
  ['25006', 'the transaction is read-only'],
];
/** Messages pg itself throws, by fixed text, so they can be named without being printed. */
const CLIENT_TEXT = [
  [/does not support SSL/i, 'the server does not offer TLS'],
  [/timeout|timed out/i, 'timed out'],
  [/terminated unexpectedly|Connection terminated/i, 'the server closed the connection'],
  [/SASL|SCRAM|password must be/i, 'authentication failed'],
];

/**
 * A fixed description of a failure: the SQLSTATE or error code, never the message (it can name
 * the host, user or database).
 * @param {unknown} err
 */
export function describeError(err) {
  const e = /** @type {{code?: unknown, message?: unknown}} */ (err ?? {});
  if (err instanceof pg.DatabaseError && typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) {
    const text = SQLSTATE_TEXT.find(([prefix]) => /** @type {string} */ (e.code).startsWith(prefix))?.[1] ?? 'server error';
    return `${text} (SQLSTATE ${e.code})`;
  }
  if (typeof e.code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(e.code)) return `error code ${e.code}`;
  const message = typeof e.message === 'string' ? e.message : '';
  return CLIENT_TEXT.find(([re]) => /** @type {RegExp} */ (re).test(message))?.[1] ?? 'no error code';
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{var: string | null, apply: boolean, help: boolean}} */
  const o = { var: null, apply: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--var' || a.startsWith('--var=')) {
      const v = a === '--var' ? argv[++i] : a.slice('--var='.length);
      if (v === undefined || !NAME_RE.test(v)) throw new UsageError('--var needs a variable name (letters, digits and _)');
      o.var = v;
    } else if (a === '--apply') o.apply = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new UsageError(/^--?[a-z-]{1,24}$/.test(a) ? `unknown option ${a}` : 'unexpected argument (the URL is read from stdin, never from arguments)');
  }
  return o;
}

/**
 * The database URL from stdin text, and how to name it in messages.
 * @param {string} text @param {string | null} explicitVar
 * @returns {{raw: string, label: string}}
 */
export function databaseUrlInput(text, explicitVar) {
  const body = text.replace(/\r?\n$/, '').trim();
  if (!/[\r\n]/.test(body) && BARE_URL.test(body)) {
    if (explicitVar) throw new UsageError(`--var ${explicitVar} names a dotenv variable, but stdin holds a bare URL`);
    return { raw: body, label: 'the URL on stdin' };
  }
  const name = explicitVar ?? DEFAULT_VAR;
  const doc = parseEnvDocument(text);
  if ('problem' in doc) throw new UsageError(`stdin is neither one postgres:// line nor a valid dotenv document: ${doc.problem}`);
  const raw = doc.vars.get(name);
  if (raw === undefined || raw === '') throw new UsageError(`${name} is not set in the dotenv document on stdin`);
  return { raw, label: name };
}

/** The URL and its parts, as the redactor's literal secrets. @param {string} raw */
function urlParts(raw) {
  const parts = databaseUrlSecrets(raw);
  try {
    const url = new URL(raw);
    const p = url.searchParams;
    for (const v of [url.host, url.hostname, url.username, url.pathname.slice(1), p.get('host'), p.get('user'), p.get('dbname')]) {
      if (v) {
        parts.push(v);
        try {
          parts.push(decodeURIComponent(v));
        } catch {
          // kept as written
        }
      }
    }
  } catch {
    // an unparsable value is scrubbed as a whole
  }
  return parts;
}

/** @param {import('../src/store/migrate.js').MigrationPlan} plan @param {(line: string) => void} say */
function printPlan(plan, say) {
  say(`PostgreSQL server major version: ${/^\d+/.exec(plan.serverVersion)?.[0] ?? 'unknown'}`);
  say(`Schema ${SCHEMA}: ${plan.schemaExists ? 'exists' : 'does not exist'}`);
  say(`Applied migrations: ${plan.applied.length ? plan.applied.map((a) => a.version).join(', ') : 'none'}`);
  say(`Pending migrations: ${plan.pending.length ? plan.pending.map((m) => `${m.version} (${m.name})`).join(', ') : 'none'}`);
  say(`Refusal: ${plan.refusal ?? 'none'}`);
}

/** @param {import('../src/store/migrate.js').MigrationPlan} plan @param {boolean} applied @param {(line: string) => void} say */
function verdict(plan, applied, say) {
  if (plan.refusal) {
    say('Refused: nothing was changed. Resolve the refusal before migrating.');
    return EXIT.REFUSED;
  }
  if (plan.pending.length === 0) {
    say('Up to date.');
    return EXIT.OK;
  }
  say(applied ? 'Still pending after the apply run; run the plan again.' : 'Pending: run again with --apply to apply them.');
  return applied ? EXIT.ERROR : EXIT.PENDING;
}

/**
 * @param {string[]} argv
 * @param {{stdin?: NodeJS.ReadableStream & {isTTY?: boolean}, stdout?: {write: (s: string) => unknown}, stderr?: {write: (s: string) => unknown}}} [io]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  /** @type {(text: unknown) => string} */
  let clean = (text) => String(text);
  const say = (/** @type {string} */ line) => stdout.write(`${clean(line)}\n`);
  const fail = (/** @type {string} */ line) => stderr.write(`migrate: ${clean(line)}\n`);
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    fail(`${err.message}\n${USAGE}`);
    return EXIT.USAGE;
  }
  if (opts.help) {
    say(USAGE);
    return EXIT.OK;
  }

  const read = await readStdin(stdin);
  if ('problem' in read) {
    fail(read.problem);
    return EXIT.USAGE;
  }
  const text = read.value.toString('utf8');
  read.value.fill(0);
  /** @type {{raw: string, label: string}} */
  let input;
  try {
    input = databaseUrlInput(text, opts.var);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    fail(err.message);
    return EXIT.USAGE;
  }
  clean = createRedactor(urlParts(input.raw)).scrub;
  // Development rules: plaintext only to a loopback host or a unix socket; any other host needs TLS.
  const config = parseDatabaseUrl(input.raw, { production: false });
  if (!config) {
    fail(
      `${input.label} is not a PostgreSQL URL the store accepts (postgres:// or postgresql://; sslmode require, verify-ca or verify-full unless the host is local; no other ssl* parameter; docs/DESIGN.md §4)`,
    );
    return EXIT.USAGE;
  }

  // The URL alone: no PG* variable may fill in what it leaves out (pg reads them at connect time).
  for (const name of Object.keys(process.env)) if (name.startsWith('PG')) delete process.env[name];
  const client = new pg.Client({ ...pgConnectionOptions(config), application_name: 'michael-router-migrate', connectionTimeoutMillis: CONNECT_TIMEOUT_MS, query_timeout: QUERY_TIMEOUT_MS });
  // A URL without a password: pg would look in ~/.pgpass; an empty one makes a server that asks for a password refuse.
  if (/** @type {any} */ (client).password === null) /** @type {any} */ (client).password = '';
  client.on('error', () => {}); // a connection lost while idle; the next query reports it
  try {
    await client.connect();
  } catch (err) {
    fail(`could not connect to the database: ${describeError(err)}`);
    // pg leaves the socket open after some login failures (a SASL exchange it cannot finish), which
    // would keep the process alive until the server gives up; close it, without waiting for an
    // 'end' that a socket already closed never emits.
    client.end().catch(() => {});
    return EXIT.ERROR;
  }
  try {
    const plan = await planMigrations(client);
    if (!opts.apply || plan.refusal) {
      printPlan(plan, say);
      return verdict(plan, false, say);
    }
    if (plan.pending.length === 0) say('Nothing to apply.');
    else {
      let applied;
      try {
        ({ applied } = await applyMigrations(client));
      } catch (err) {
        if (!(err instanceof MigrationRefusedError)) throw err;
        say(`Refusal: ${err.message}`);
        say('Refused: nothing was changed. Resolve the refusal before migrating.');
        return EXIT.REFUSED;
      }
      if (applied.length === 0) say('No migration applied: a concurrent run applied them first.');
      for (const version of applied) say(`Applied migration ${version} (${plan.pending.find((m) => m.version === version)?.name ?? 'unnamed'})`);
    }
    const final = await planMigrations(client);
    printPlan(final, say);
    return verdict(final, true, say);
  } catch (err) {
    fail(`the database refused the request: ${describeError(err)}${opts.apply ? '. Run the plan again to see what was applied.' : ''}`);
    return EXIT.ERROR;
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`migrate: unexpected ${/** @type {Error} */ (err)?.name ?? 'error'}\n`);
      process.exitCode = EXIT.ERROR;
    },
  );
}
