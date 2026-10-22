// CLI internals in-process: argument parsing, URL rules, the hidden prompt on a fake terminal,
// piped secrets, and atomic 0600 writes.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';
import { parseArgv } from '../../cli/lib/args.js';
import { COMMANDS } from '../../cli/lib/commands.js';
import { configPaths, readCredentials, writeConfig, writeCredentials } from '../../cli/lib/config.js';
import { EXIT } from '../../cli/lib/errors.js';
import { normalizeUrl } from '../../cli/lib/http.js';
import { promptHidden, readSecret } from '../../cli/lib/prompt.js';

/** @type {string[]} */
const dirs = [];
after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

/** @param {() => unknown} fn */
function usageMessage(fn) {
  try {
    fn();
  } catch (err) {
    assert.equal(/** @type {any} */ (err).exitCode, EXIT.USAGE);
    return /** @type {Error} */ (err).message;
  }
  assert.fail('expected a usage error');
}

test('argv: global flags anywhere, --flag=value, short flags, subcommands and -- ending flags', () => {
  const a = parseArgv(['--json', 'ask', '-m', 'gemini-2.5-flash', '--max-tokens=5', 'hello', '--', '--not-a-flag', '--timeout', '9'], COMMANDS);
  assert.deepEqual(a.path, ['ask']);
  assert.deepEqual(a.flags, { json: true, model: 'gemini-2.5-flash', 'max-tokens': '5' });
  assert.deepEqual(a.positionals, ['hello', '--not-a-flag', '--timeout', '9']);
  const k = parseArgv(['keys', 'set', 'claude', '--no-verify', '--url', 'https://r.example'], COMMANDS);
  assert.deepEqual([k.path, k.positionals, k.flags], [['keys', 'set'], ['claude'], { 'no-verify': true, url: 'https://r.example' }]);
  assert.equal(parseArgv(['keys', 'set', '-h', '--bogus'], COMMANDS).help, true);
});

test('argv errors are usage errors that never echo a value or a secret-looking token', () => {
  assert.equal(usageMessage(() => parseArgv(['login', '--password=pw-SENTINEL-argv'], COMMANDS)), 'unknown flag --password');
  assert.equal(usageMessage(() => parseArgv(['health', '--json=pw-SENTINEL-argv'], COMMANDS)), '--json takes no value');
  assert.equal(usageMessage(() => parseArgv(['sk-ant-fake-SENTINEL-cmd'], COMMANDS)), 'unknown command');
  assert.equal(usageMessage(() => parseArgv(['-sk-ant-fake-SENTINEL-flag'], COMMANDS)), 'unknown flag');
  assert.equal(usageMessage(() => parseArgv(['helth'], COMMANDS)), 'unknown command "helth"');
  assert.equal(usageMessage(() => parseArgv(['keys', 'add'], COMMANDS)), 'unknown keys subcommand "add"');
  assert.equal(usageMessage(() => parseArgv(['ask', '-m'], COMMANDS)), '-m needs a value');
  assert.equal(usageMessage(() => parseArgv(['-m', 'x', 'ask'], COMMANDS)), 'unknown flag -m', 'command flags go after the command');
});

test('router URL: https required except loopback; no credentials, query or fragment; trailing / and /v1 removed', () => {
  assert.equal(normalizeUrl('https://router.example.com/'), 'https://router.example.com');
  assert.equal(normalizeUrl('https://router.example.com/v1/'), 'https://router.example.com');
  assert.equal(normalizeUrl('https://router.example.com/base//'), 'https://router.example.com/base');
  assert.equal(normalizeUrl('http://localhost:8787'), 'http://localhost:8787');
  assert.equal(normalizeUrl('http://127.0.0.1:8787/v1'), 'http://127.0.0.1:8787');
  assert.equal(normalizeUrl('http://[::1]:8787'), 'http://[::1]:8787');
  assert.equal(normalizeUrl('https://Router.Example.com:443/'), 'https://router.example.com');
  const refused = [
    'http://router.example.com',
    'http://127.0.0.2',
    'ftp://router.example.com',
    'https://u:p@router.example.com',
    'https://r.example?x=1',
    'https://r.example#f',
    'router.example.com',
    // The parsed host must be the host as typed: a backslash, an encoded, shortened or
    // whitespace-split host would send the password somewhere other than where the URL reads.
    'https://evil.example\\@router.example',
    'https://router%2eexample.com',
    'http://127.1:8787',
    'https://router.exa\tmple.com',
  ];
  for (const bad of refused) {
    assert.match(usageMessage(() => normalizeUrl(bad)), /router URL/, bad);
  }
});

/** A stand-in for a TTY stdin: records raw-mode changes; `type` feeds keystrokes. */
function fakeTty() {
  const tty = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    /** @type {boolean[]} */
    modes: [],
    /** @param {boolean} mode */
    setRawMode(mode) {
      tty.isRaw = mode;
      tty.modes.push(mode);
    },
    setEncoding() {},
    pause() {},
    resume() {},
    /** @param {string} keys */
    type(keys) {
      tty.emit('data', keys);
    },
  });
  return tty;
}
function capture() {
  const out = { text: '', write: (/** @type {string} */ s) => void (out.text += s) };
  return out;
}

test('hidden prompt: raw mode before the label, no echo, editing keys and escape sequences, terminal restored', async () => {
  const stdin = fakeTty();
  const stderr = capture();
  const p = promptHidden({ label: 'Password: ', stdin: /** @type {any} */ (stdin), stderr });
  assert.deepEqual(stdin.modes, [true], 'raw mode is on before anything is typed');
  assert.equal(stderr.text, 'Password: ');
  stdin.type('wrong\u0015'); // Ctrl-U clears the line
  stdin.type('pw-SENTINEL-tyXZ');
  stdin.type('\u007f\bped'); // DEL and BS each remove one character
  stdin.type('\u001b[D\u001b[200~-é\u001b[201~\u001bOA'); // arrow keys, bracketed paste, SS3: only the pasted text counts
  stdin.type('\u0001\r ignored after enter');
  assert.equal(await p, 'pw-SENTINEL-typed-é');
  assert.deepEqual(stdin.modes, [true, false]);
  assert.equal(stderr.text, 'Password: \n', 'nothing typed is ever echoed');
  assert.equal(stdin.listenerCount('data'), 0);
});

test('hidden prompt: Ctrl-C restores the terminal and exits 130; Ctrl-D submits', async () => {
  const stdin = fakeTty();
  const p = promptHidden({ label: 'Password: ', stdin: /** @type {any} */ (stdin), stderr: capture() });
  stdin.type('pw-SENTINEL-\u0003');
  await assert.rejects(p, (/** @type {any} */ err) => err.exitCode === EXIT.INTERRUPTED && !String(err.message).includes('SENTINEL'));
  assert.deepEqual(stdin.modes, [true, false]);

  const again = fakeTty();
  const q = promptHidden({ label: '', stdin: /** @type {any} */ (again), stderr: capture() });
  again.type('abc\u0004');
  assert.equal(await q, 'abc');
});

test('readSecret on a terminal: empty is refused; confirmation must match', async () => {
  const empty = fakeTty();
  const p = readSecret({ label: 'Password: ', what: 'password', stdin: /** @type {any} */ (empty), stderr: capture() });
  empty.type('\r');
  await assert.rejects(p, (/** @type {any} */ err) => err.exitCode === EXIT.USAGE && /no password entered/.test(err.message));

  const tty = fakeTty();
  const stderr = capture();
  const q = readSecret({ label: 'New: ', what: 'password', stdin: /** @type {any} */ (tty), stderr, confirm: true });
  tty.type('first-SENTINEL\r');
  await new Promise((r) => setImmediate(r));
  tty.type('other-SENTINEL\r');
  await assert.rejects(q, (/** @type {any} */ err) => err.exitCode === EXIT.USAGE && /did not match/.test(err.message));
  assert.equal(stderr.text, 'New: \nRepeat to confirm: \n');
});

test('piped secrets: one trailing newline removed; empty and multi-line input refused', async () => {
  /** @param {string} text */
  const piped = (text) => readSecret({ label: 'x', what: 'key', stdin: /** @type {any} */ (Readable.from([Buffer.from(text)])), stderr: capture() });
  assert.equal(await piped('sk-ant-fake-SENTINEL-1\n'), 'sk-ant-fake-SENTINEL-1');
  assert.equal(await piped('sk-ant-fake-SENTINEL-2\r\n'), 'sk-ant-fake-SENTINEL-2');
  assert.equal(await piped('  spaced  '), '  spaced  ', 'only the newline is stripped');
  for (const [text, message] of [
    ['', /no key on stdin/],
    ['\n', /no key on stdin/],
    ['a\nb', /single line/],
    ['abc\n\n', /single line/],
  ]) {
    await assert.rejects(piped(/** @type {string} */ (text)), (/** @type {any} */ err) => err.exitCode === EXIT.USAGE && /** @type {RegExp} */ (message).test(err.message));
  }
});

test('atomic 0600 writes: dir tightened to 0700, files replaced by rename (never written through), no temp files left; symlinked credentials refused', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mrouter-unit-'));
  dirs.push(home);
  const paths = configPaths({ HOME: home });
  assert.equal(paths.dir, path.join(home, '.config', 'michael-router'));
  assert.equal(configPaths({ HOME: home, XDG_CONFIG_HOME: '/xdg' }).dir, '/xdg/michael-router');
  assert.equal(configPaths({ HOME: home, XDG_CONFIG_HOME: 'relative' }).dir, paths.dir, 'a relative XDG_CONFIG_HOME is ignored');

  await mkdir(paths.dir, { recursive: true, mode: 0o755 });
  await writeFile(paths.credentials, 'old', { mode: 0o644 });
  const before = await lstat(paths.credentials);
  await writeCredentials(paths, 'pw-SENTINEL-atomic');
  const afterWrite = await lstat(paths.credentials);
  assert.notEqual(afterWrite.ino, before.ino, 'a new file was renamed into place');
  assert.equal(afterWrite.mode & 0o777, 0o600);
  assert.equal((await lstat(paths.dir)).mode & 0o777, 0o700);
  assert.equal(await readFile(paths.credentials, 'utf8'), 'pw-SENTINEL-atomic');

  // A symlink planted at the target is replaced, and its destination is never written.
  const outside = path.join(home, 'outside.txt');
  await writeFile(outside, 'untouched');
  await symlink(outside, paths.config);
  await writeConfig(paths, { url: 'https://router.example.com' });
  assert.equal(await readFile(outside, 'utf8'), 'untouched');
  assert.ok((await lstat(paths.config)).isFile());
  assert.equal((await lstat(paths.config)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(paths.config, 'utf8')), { url: 'https://router.example.com' });
  assert.deepEqual((await readdir(paths.dir)).sort(), ['config.json', 'credentials']);

  // Reading never follows a symlink.
  await rm(paths.credentials);
  await symlink(outside, paths.credentials);
  await assert.rejects(readCredentials(paths, () => {}), /symbolic link/);
});
