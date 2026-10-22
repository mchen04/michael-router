// Account and control commands through the real mrouter binary against dev/server.js processes
// (fake Upstash, fake providers): login / logout / status, health, keys, models, errors, the URL
// binding of the stored password, and the exit-code mapping for router refusals and the network.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { COMMANDS } from '../../cli/lib/commands.js';
import { VERSION } from '../../src/version.js';
import { CLI, configDir, finishCliSuite, loggedInHome, makeHome, runCli, startRouterStack, tableRows, waitForJson } from '../helpers/cli.js';
import { ENV_KEYS, PASSWORD, ROUTER_SECRET, WRONG_PASSWORD, passwordHash } from '../helpers/fixtures.js';
import { startDevServer } from '../helpers/processes.js';
import { startRedirectTrap } from '../helpers/redirect-trap.js';

/** @type {Awaited<ReturnType<typeof startRouterStack>>} */
let stack;
/** Providers configured but unreachable. @type {Awaited<ReturnType<typeof startDevServer>>} */
let offline;
/** Blocks a source after two wrong passwords. @type {Awaited<ReturnType<typeof startDevServer>>} */
let strict;
/** A home logged in to `stack`. */
let home = '';

before(async () => {
  const hash = await passwordHash();
  [stack, offline, strict] = await Promise.all([
    startRouterStack({ AUTH_BACKOFF_BASE_MS: '1' }),
    startDevServer({ ROUTER_PASSWORD_HASH: hash, ROUTER_SECRET, ROUTER_STORE: 'memory', ...ENV_KEYS }),
    startDevServer({ ROUTER_PASSWORD_HASH: hash, ROUTER_SECRET, ROUTER_STORE: 'memory', AUTH_MAX_FAILURES: '2', AUTH_BACKOFF_BASE_MS: '1', AUTH_BLOCK_SECONDS: '600' }),
  ]);
  home = await loggedInHome(stack.url);
});
after(async () => {
  await Promise.all([stack?.stop(), offline?.stop(), strict?.stop()]);
  await finishCliSuite();
});

/** @param {string[]} args @param {Omit<Parameters<typeof runCli>[1], 'home'> & {home?: string}} [options] */
const mr = (args, options = {}) => runCli(args, { home, ...options });
/** @param {string} s */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

test('login checks the password, then saves URL and password (dir 0700, files 0600); status reports it without the value', async () => {
  const h = await makeHome();
  const r = await runCli(['login', '--url', `${stack.url}/v1/`], { home: h, input: `${PASSWORD}\n` });
  assert.equal(r.code, 0, r.stderr);
  const dir = configDir(h);
  assert.equal(r.stdout, `Logged in to ${stack.url}.\nThe password is stored in ${path.join(dir, 'credentials')} (mode 0600).\n`);
  assert.equal((await lstat(dir)).mode & 0o777, 0o700);
  for (const f of ['config.json', 'credentials']) assert.equal((await lstat(path.join(dir, f))).mode & 0o777, 0o600, f);
  assert.equal(await readFile(path.join(dir, 'credentials'), 'utf8'), PASSWORD);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'config.json'), 'utf8')), { url: stack.url });

  const status = await runCli(['status'], { home: h });
  assert.equal(status.code, 0);
  assert.match(status.stdout, new RegExp(`^URL +${esc(stack.url)} \\(from config.json\\)$`, 'm'));
  assert.match(status.stdout, /^Password +stored$/m);
  assert.match(status.stdout, /^credentials +.+credentials \(mode 0600\)$/m);
  const json = JSON.parse((await runCli(['status', '--json'], { home: h })).stdout);
  assert.deepEqual(json.password, { stored: true, stored_for: stack.url, env: false, usable: true });
  assert.equal(json.url_source, 'config.json');
  assert.match((await runCli(['status', '--url', 'https://other.example'], { home: h })).stdout, /^Password +stored for http:\/\/127\.0\.0\.1:\d+ only/m);
  const env = await runCli(['status'], { home: h, env: { MROUTER_PASSWORD: PASSWORD, MROUTER_URL: 'https://router.example.com/v1' } });
  assert.match(env.stdout, /^URL +https:\/\/router\.example\.com \(from MROUTER_URL\)$/m);
  assert.match(env.stdout, /^Password +from MROUTER_PASSWORD/m);
  const bad = await runCli(['status'], { home: h, env: { MROUTER_URL: 'http://router.example.com' } });
  assert.deepEqual([bad.code, bad.stderr], [2, 'mrouter: the router URL must use https:// (http:// only for localhost, 127.0.0.1 or ::1)\n']);
});

test('login: a wrong password exits 3 and saves nothing; arguments, password flags and empty input are refused', async () => {
  const h = await makeHome();
  const wrong = await runCli(['login', '--url', stack.url], { home: h, input: `${WRONG_PASSWORD}\n` });
  assert.equal(wrong.code, 3);
  assert.equal(wrong.stderr, 'mrouter: router refused the request (HTTP 401, invalid_credentials): Invalid credentials. (nothing was saved)\n');
  await assert.rejects(lstat(configDir(h)), { code: 'ENOENT' });
  const cases = [
    [['login', '--url', stack.url, 'pw-SENTINEL-in-argv'], 'mrouter: login takes no arguments; the password is read from the prompt or stdin, never from arguments\n'],
    [['login', '--password=pw-SENTINEL-in-flag'], "mrouter: unknown flag --password (see 'mrouter login --help')\n"],
    [['login', '--url', stack.url], 'mrouter: no password on stdin\n'],
    [['login'], "mrouter: no router URL: pass --url, set MROUTER_URL or run 'mrouter login --url URL'\n"],
  ];
  for (const [args, stderr] of /** @type {[string[], string][]} */ (cases)) {
    const r = await runCli(args, { home: h });
    assert.deepEqual([r.code, r.stderr, r.stdout], [2, stderr, ''], args.join(' '));
  }
  await assert.rejects(lstat(configDir(h)), { code: 'ENOENT' });
});

test('the stored password is only sent to the URL it was saved for; a redirect is never followed (exit 5)', async () => {
  const trap = await startRedirectTrap();
  try {
    const refused = await mr(['health', '--url', trap.url]);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /^mrouter: the stored password was saved for http:\/\/127\.0\.0\.1:\d+ and is only sent there \(run 'mrouter login --url http:\/\/127\.0\.0\.1:\d+' or set MROUTER_PASSWORD\)\n$/);
    const redirected = await mr(['models', '--url', trap.url], { env: { MROUTER_PASSWORD: PASSWORD } });
    assert.equal(redirected.code, 5);
    assert.equal(redirected.stderr, `mrouter: ${trap.url} answered with a redirect; mrouter never follows redirects (check the URL)\n`);
    assert.deepEqual(trap.received, [], 'nothing reached the redirect target');
  } finally {
    await trap.close();
  }
});

test('health: table and JSON; an unreachable router exits 5', async () => {
  const r = await mr(['health']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Status +ok$/m);
  assert.match(r.stdout, new RegExp(`^Version +${esc(VERSION)}$`, 'm'));
  assert.match(r.stdout, /^Instance +started \d{4}-\d\d-\d\d \d\d:\d\d:\d\d \(.+\), (cold start|warm)$/m);
  assert.match(r.stdout, /^Store +memory, \d+ ms$/m);
  assert.match(r.stdout, /^Providers +claude configured, gemini configured, openrouter configured$/m);
  assert.match(r.stdout, /^Round trip +\d+ ms$/m);
  const json = JSON.parse((await mr(['health', '--json'])).stdout);
  assert.deepEqual([json.status, json.providers.gemini], ['ok', { configured: true }]);
  const down = await mr(['health', '--url', 'http://127.0.0.1:1'], { env: { MROUTER_PASSWORD: PASSWORD } });
  assert.equal(down.code, 5);
  assert.match(down.stderr, /^mrouter: cannot reach http:\/\/127\.0\.0\.1:1( \(\w+\))?\n$/);
});

test('a credentials file readable by others triggers a warning', async () => {
  const file = path.join(configDir(home), 'credentials');
  await chmod(file, 0o644);
  try {
    const r = await mr(['keys', 'list']);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /^mrouter: warning: .+credentials is accessible by other users \(mode 0644\); run: chmod 600 '.+credentials'\n$/);
  } finally {
    await chmod(file, 0o600);
  }
});

test('keys: list, set with verification accepted / rejected / unverifiable (nothing stored), --no-verify, unset', async () => {
  assert.deepEqual(tableRows((await mr(['keys', 'list'])).stdout), [
    ['PROVIDER', 'CONFIGURED', 'SOURCE', 'UPDATED'],
    ['claude', 'yes', 'env', '-'],
    ['gemini', 'yes', 'env', '-'],
    ['openrouter', 'yes', 'env', '-'],
  ]);
  const set = await mr(['keys', 'set', 'claude'], { input: 'sk-ant-fake-SENTINEL-cli-claude-0011\n' });
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stdout, /^Stored the claude key on the router \(updated \d{4}-\d\d-\d\d \d\d:\d\d:\d\d \(just now\)\)\.\nVerified: claude accepted the key \(HTTP 200\)\.\n$/);
  const listed = JSON.parse((await mr(['keys', 'list', '--json'])).stdout);
  assert.deepEqual(listed.map((/** @type {any} */ k) => `${k.provider}:${k.source}`), ['claude:store', 'gemini:env', 'openrouter:env']);
  assert.match(tableRows((await mr(['keys', 'list'])).stdout)[1][3], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \(/);

  const rejected = await mr(['keys', 'set', 'gemini', '--json'], { input: 'AIzaFAKE-revoked-SENTINEL-12\n' });
  assert.deepEqual([rejected.code, rejected.stdout], [4, '']);
  assert.equal(rejected.stderr, "mrouter: gemini rejected the key (HTTP 400); it was not stored (check the key and run 'mrouter keys set gemini' again)\n");
  assert.equal(tableRows((await mr(['keys', 'list'])).stdout)[2][2], 'env', 'the gemini key in use is unchanged');

  const offlineEnv = { env: { MROUTER_PASSWORD: PASSWORD } };
  const unreachable = await mr(['keys', 'set', 'claude', '--url', offline.url], { ...offlineEnv, input: 'sk-ant-fake-SENTINEL-offline-0013' });
  assert.deepEqual([unreachable.code, unreachable.stdout], [4, '']);
  assert.equal(
    unreachable.stderr,
    "mrouter: could not verify the claude key (the provider could not be reached); it was not stored (retry, or store it unverified with 'mrouter keys set claude --no-verify')\n",
  );
  assert.equal(tableRows((await mr(['keys', 'list', '--url', offline.url], offlineEnv)).stdout)[1][2], 'env');

  const unverified = await mr(['keys', 'set', 'gemini', '--no-verify'], { input: 'AIzaFAKE-SENTINEL-noverify-14' });
  assert.equal(unverified.code, 0, unverified.stderr);
  assert.match(unverified.stdout, /\nNot verified \(--no-verify\)\.\n$/);

  assert.equal((await mr(['keys', 'unset', 'gemini'])).stdout, 'Removed the stored gemini key. gemini now uses the environment key.\n');
  const again = JSON.parse((await mr(['keys', 'unset', 'gemini', '--json'])).stdout);
  assert.deepEqual([again.removed, again.source], [false, 'env']);
  assert.equal((await mr(['keys', 'unset', 'claude'])).code, 0);
});

test('keys set refuses keys given as arguments and malformed keys; provider arguments are checked', async () => {
  const refusal = 'mrouter: provider keys are never accepted as arguments; pipe them on stdin or use the prompt\n';
  const cases = [
    [['keys', 'set', 'claude', 'sk-ant-fake-SENTINEL-argv-0015'], refusal],
    [['keys', 'set', 'sk-ant-fake-SENTINEL-argv-0015'], refusal],
    [['keys', 'set', 'claude', '--key=sk-ant-fake-SENTINEL-argv-0015'], "mrouter: unknown flag --key (see 'mrouter keys set --help')\n"],
    [['keys', 'set', 'anthropic'], 'mrouter: unknown provider "anthropic"; use one of: claude, gemini, openrouter\n'],
    [['keys', 'unset'], 'mrouter: keys unset needs a provider: claude, gemini, openrouter\n'],
    [['keys', 'unset', 'sk-ant-fake-SENTINEL-argv-0016'], 'mrouter: unknown provider; use one of: claude, gemini, openrouter\n'],
  ];
  for (const [args, stderr] of /** @type {[string[], string][]} */ (cases)) {
    const r = await mr(args, { input: 'sk-ant-fake-SENTINEL-stdin-0017\n' });
    assert.deepEqual([r.code, r.stderr, r.stdout], [2, stderr, ''], args.join(' '));
  }
  const malformed = await mr(['keys', 'set', 'claude'], { input: 'sk-ant fake SENTINEL\n' });
  assert.deepEqual([malformed.code, malformed.stderr], [2, 'mrouter: invalid claude key: key must not contain whitespace; nothing was sent\n']);
  const keys = JSON.parse((await mr(['keys', 'list', '--json'])).stdout);
  assert.deepEqual(keys.map((/** @type {any} */ k) => k.source), ['env', 'env', 'env'], 'nothing was stored');
});

test('models: table and JSON', async () => {
  const r = await mr(['models']);
  assert.equal(r.code, 0, r.stderr);
  const [header, ...rows] = tableRows(r.stdout);
  assert.deepEqual(header, ['MODEL', 'PROVIDER', 'CONTEXT', 'MAX OUTPUT']);
  const json = JSON.parse((await mr(['models', '--json'])).stdout);
  assert.equal(json.object, 'list');
  assert.deepEqual(
    rows.map((row) => row.slice(0, 2)),
    json.data.map((/** @type {any} */ m) => [m.id, m.owned_by]),
  );
  assert.deepEqual([...new Set(rows.map((row) => row[1]))].sort(), ['claude', 'gemini', 'openrouter']);
  for (const row of rows) for (const n of row.slice(2)) assert.match(n, /^(\d{1,3}(,\d{3})*|-)$/);
});

test('errors: newest first with time, kind, code, status, provider/model and static message; auth events carry the source', async () => {
  assert.equal((await mr(['ask', '--no-stream', '-m', 'claude-fake-500', 'hi'])).code, 4);
  await waitForJson(stack.url, '/control/errors?kind=upstream', (e) => e.some((/** @type {any} */ x) => x.model === 'claude-fake-500'));
  assert.equal((await mr(['ask', '--no-stream', '-m', 'gemini-fake-503', 'hi'])).code, 4);
  await waitForJson(stack.url, '/control/errors?kind=upstream', (e) => e.some((/** @type {any} */ x) => x.model === 'gemini-fake-503'));
  const r = await mr(['errors', '--kind', 'upstream', '--limit', '2']);
  assert.equal(r.code, 0, r.stderr);
  const [header, newest, older] = tableRows(r.stdout);
  assert.deepEqual(header, ['TIME', 'KIND', 'CODE', 'STATUS', 'PROVIDER/MODEL', 'SOURCE', 'MESSAGE']);
  assert.match(newest[0], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \((just now|\d+s ago)\)$/);
  assert.deepEqual(newest.slice(1), ['upstream', 'UNAVAILABLE', '503', 'gemini/gemini-fake-503', '-', 'The provider answered HTTP 503.']);
  assert.deepEqual(older.slice(1), ['upstream', 'api_error', '500', 'claude/claude-fake-500', '-', 'The provider answered HTTP 500.']);

  assert.equal((await mr(['health'], { env: { MROUTER_PASSWORD: WRONG_PASSWORD } })).code, 3);
  await waitForJson(stack.url, '/control/errors?kind=auth', (e) => e.length > 0);
  const auth = tableRows((await mr(['errors', '--kind', 'auth', '--limit', '1'])).stdout)[1];
  assert.deepEqual(auth.slice(1), ['auth', 'invalid_credentials', '401', '-', '127.0.0.1', 'Wrong password.']);
  const json = JSON.parse((await mr(['errors', '--json', '--limit', '3'])).stdout);
  assert.ok(Array.isArray(json) && json.length === 3);
  assert.equal(json[0].kind, 'auth');

  for (const [args, stderr] of [
    [['errors', '--kind', 'bogus'], 'mrouter: --kind must be one of: auth, upstream, gateway\n'],
    [['errors', '--limit', '0'], 'mrouter: --limit must be an integer from 1 to 200\n'],
  ]) {
    const e = await mr(/** @type {string[]} */ (args));
    assert.deepEqual([e.code, e.stderr], [2, stderr]);
  }
});

test('logout deletes the stored password; commands then need one again', async () => {
  const h = await loggedInHome(stack.url);
  const file = path.join(configDir(h), 'credentials');
  assert.equal((await runCli(['logout'], { home: h })).stdout, `Removed the stored password (${file}).\n`);
  await assert.rejects(lstat(file), { code: 'ENOENT' });
  assert.equal((await runCli(['logout'], { home: h })).stdout, 'No stored password.\n');
  const later = await runCli(['health'], { home: h });
  assert.deepEqual([later.code, later.stderr], [2, "mrouter: no router password: run 'mrouter login' or set MROUTER_PASSWORD\n"]);
  const extra = await runCli(['logout', 'now'], { home: h });
  assert.deepEqual([extra.code, extra.stderr], [2, 'mrouter: logout takes no arguments\n']);
});

test('a malformed stored password is refused with exit 2 and never sent', async () => {
  const h = await loggedInHome(stack.url);
  const file = path.join(configDir(h), 'credentials');
  for (const bad of [`${PASSWORD}\nsecond-line`, ` ${PASSWORD}`, `${PASSWORD}\u0001`]) {
    await writeFile(file, bad);
    const r = await runCli(['health'], { home: h });
    assert.deepEqual(
      [r.code, r.stdout, r.stderr],
      [2, '', `mrouter: the stored password in ${file} is malformed: it must be one line of printable ASCII without leading or trailing spaces (run 'mrouter login' again)\n`],
    );
  }
});

test('router auth and limit refusals exit 3 and print the code and Retry-After', async () => {
  const h = await makeHome();
  /** @param {string[]} args @param {string} password */
  const run = (args, password) => runCli([...args, '--url', strict.url], { home: h, env: { MROUTER_PASSWORD: password } });
  const first = await run(['keys', 'list'], WRONG_PASSWORD);
  assert.deepEqual(
    [first.code, first.stderr],
    [3, "mrouter: router refused the request (HTTP 401, invalid_credentials): Invalid credentials. (run 'mrouter login' or check MROUTER_PASSWORD)\n"],
  );
  const second = await run(['models'], WRONG_PASSWORD);
  assert.equal(second.code, 3);
  assert.match(second.stderr, /^mrouter: router refused the request \(HTTP 401, invalid_credentials\): Invalid credentials\. Retry after 600 s\./);
  const blocked = await run(['health'], PASSWORD);
  assert.equal(blocked.code, 3, 'blocked even with the right password');
  assert.match(blocked.stderr, /^mrouter: router refused the request \(HTTP 429, source_blocked\): .+ Retry after \d+ s\.\n$/);
});

test('usage errors exit 2 with a one-line hint; help; --version; the bin runs directly', async () => {
  const cases = [
    [['nope'], "mrouter: unknown command \"nope\" (see 'mrouter --help')\n"],
    [['health', '--bogus'], "mrouter: unknown flag --bogus (see 'mrouter health --help')\n"],
    [['keys'], "mrouter: keys needs a subcommand: list, set, unset (see 'mrouter keys --help')\n"],
    [['health', '--timeout', 'soon'], 'mrouter: --timeout must be a number of seconds from 0.1 to 3600\n'],
    [['health', 'extra'], 'mrouter: health takes no arguments\n'],
  ];
  for (const [args, stderr] of /** @type {[string[], string][]} */ (cases)) {
    const r = await mr(args);
    assert.deepEqual([r.code, r.stderr, r.stdout], [2, stderr, ''], args.join(' '));
  }
  const top = await mr(['--help']);
  assert.equal(top.code, 0);
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    for (const p of cmd.subcommands ? Object.keys(cmd.subcommands).map((sub) => `${name} ${sub}`) : [name]) {
      assert.match(top.stdout, new RegExp(`^  ${esc(p)}\\b`, 'm'), `top-level help lists ${p}`);
    }
  }
  const help = await mr(['keys', 'set', '-h']);
  assert.ok(help.stdout.startsWith('Usage: mrouter keys set <claude|gemini|openrouter> [--no-verify]\n'));
  assert.equal((await mr(['help', 'keys', 'set'])).stdout, help.stdout);
  assert.equal((await mr(['--version'])).stdout, `mrouter ${VERSION}\n`);

  const direct = await promisify(execFile)(CLI, ['--version'], { env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home } });
  assert.equal(direct.stdout, `mrouter ${VERSION}\n`);
});
