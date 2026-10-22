// Run the real mrouter binary as a child process with an isolated HOME and XDG_CONFIG_HOME and an
// explicit environment (nothing inherited from the test runner). Every run's output is kept so
// each suite can assert, at the end, that no secret ever reached the CLI's stdout or stderr.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeProviders } from '../../dev/fake-providers.js';
import { ENV_KEYS, PASSWORD, ROUTER_SECRET, passwordHash } from './fixtures.js';
import { startDevServer } from './processes.js';

export const CLI = fileURLToPath(new URL('../../cli/mrouter.js', import.meta.url));
/** Every fixture secret contains this marker; CLI output never may. */
export const SECRET_MARKER = 'SENTINEL';

/** @type {{label: string, stdout: string, stderr: string, tty: boolean}[]} */
const transcripts = [];
/** @type {string[]} */
const homes = [];

/** @param {string[]} args */
const label = (args) => args.map((a) => (a.includes(SECRET_MARKER) ? '<secret>' : a)).join(' ');

/** A fresh, empty home directory for one CLI user. */
export async function makeHome() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mrouter-cli-'));
  homes.push(dir);
  return dir;
}

/** @param {string} home */
export const configDir = (home) => path.join(home, '.config', 'michael-router');

/** @param {string} home @param {Record<string, string>} env */
const cliEnv = (home, env) => ({ HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), ...env });

/**
 * @typedef {{code: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string,
 *   chunks: {stream: 'stdout' | 'stderr', ms: number, text: string}[], exitMs: number}} CliResult
 */

/**
 * @param {string[]} args
 * @param {{home: string, env?: Record<string, string>, input?: string, timeoutMs?: number}} options
 * @returns {Promise<CliResult>}
 */
export function runCli(args, { home, env = {}, input = '', timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], { env: cliEnv(home, env), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    /** @type {CliResult['chunks']} */
    const chunks = [];
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
      chunks.push({ stream: 'stdout', ms: Date.now() - t0, text: d });
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      chunks.push({ stream: 'stderr', ms: Date.now() - t0, text: d });
    });
    child.stdin.on('error', () => {}); // the CLI may exit without reading stdin
    child.stdin.end(input);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`mrouter ${label(args)} timed out`));
    }, timeoutMs);
    let exitMs = 0;
    child.on('exit', () => {
      exitMs = Date.now() - t0;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      transcripts.push({ label: label(args), stdout, stderr, tty: false });
      resolve({ code, signal, stdout, stderr, chunks, exitMs });
    });
  });
}

/** BSD script(1) gives the CLI a pseudo-terminal; available on macOS. */
export const PTY_SKIP = process.platform === 'darwin' ? false : 'needs the BSD script(1) pseudo-terminal wrapper (macOS)';

/**
 * Run the CLI on a pseudo-terminal (stdin, stdout and stderr are the same TTY). Each step waits
 * until the output since the previous step matches `waitFor`, then types `send`.
 * script(1) needs a real pipe as its stdin, hence the `cat |`; its exit status is reported on
 * stderr because the shell waits for cat, which ends when the test closes stdin.
 * @param {string[]} args
 * @param {{home: string, env?: Record<string, string>, steps?: {waitFor: RegExp, send: string}[], timeoutMs?: number}} options
 * @returns {Promise<{code: number, output: string}>}
 */
export function runCliPty(args, { home, env = {}, steps = [], timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const script = 'cat | { /usr/bin/script -q /dev/null "$@"; echo "pty-exit:$?" >&2; }';
    const child = spawn('/bin/sh', ['-c', script, 'sh', process.execPath, CLI, ...args], { env: cliEnv(home, env), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    let from = 0;
    let step = 0;
    /** @type {number | undefined} */
    let code;
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      output += d;
      while (step < steps.length && steps[step].waitFor.test(output.slice(from))) {
        from = output.length;
        child.stdin.write(steps[step++].send);
      }
    });
    child.stderr.on('data', (d) => {
      errors += d;
      const m = /pty-exit:(\d+)/.exec(errors);
      if (m && code === undefined) {
        code = Number(m[1]);
        child.stdin.end();
      }
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`mrouter ${label(args)} on a pty timed out at step ${step}`));
    }, timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      transcripts.push({ label: label(args), stdout: output, stderr: errors.replace(/pty-exit:\d+\n?/, ''), tty: true });
      if (code === undefined) reject(new Error(`mrouter ${label(args)} on a pty ended without an exit status`));
      else resolve({ code, output });
    });
  });
}

/** Remove ANSI escape sequences and normalize the pty's CRLF. @param {string} s */
export const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r\n/g, '\n');

/**
 * The suite-wide guarantees: no secret marker in any CLI output, and no ANSI color codes in
 * output that did not go to a terminal. Also removes the temporary homes.
 */
export async function finishCliSuite() {
  await Promise.all(homes.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  assert.ok(transcripts.length > 0);
  for (const t of transcripts) {
    assert.ok(!t.stdout.includes(SECRET_MARKER) && !t.stderr.includes(SECRET_MARKER), `a secret reached the output of: mrouter ${t.label}`);
    if (!t.tty) assert.ok(!/\x1b\[/.test(t.stdout + t.stderr), `color codes without a terminal: mrouter ${t.label}`);
  }
}

/**
 * A router (one dev/server.js process, memory store) with the fake providers, every provider
 * configured with a fake env key.
 * @param {Record<string, string>} [env]
 */
export async function startRouterStack(env = {}) {
  const fake = await startFakeProviders();
  const dev = await startDevServer({
    ROUTER_PASSWORD_HASH: await passwordHash(),
    ROUTER_SECRET,
    ROUTER_STORE: 'memory',
    ...ENV_KEYS,
    ...fake.env,
    ...env,
  });
  return {
    fake,
    url: dev.url,
    async stop() {
      await Promise.all([dev.stop(), fake.close()]);
    },
  };
}

/** A home logged in to `url` with the fixture password (via stdin). @param {string} url */
export async function loggedInHome(url) {
  const home = await makeHome();
  const r = await runCli(['login', '--url', url], { home, input: `${PASSWORD}\n` });
  assert.equal(r.code, 0, r.stderr);
  return home;
}

/**
 * Poll the router directly until `check` accepts the JSON at `path` (usage and events are
 * written in the background after a response).
 * @param {string} url @param {string} path @param {(json: any) => boolean} check
 */
export async function waitForJson(url, path, check) {
  for (let i = 0; i < 100; i++) {
    const json = await (await fetch(url + path, { headers: { authorization: `Bearer ${PASSWORD}` } })).json();
    if (check(json)) return json;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

/** The cells of a plain-text table: one array per line, columns split on runs of 2+ spaces. @param {string} text */
export const tableRows = (text) =>
  text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.trim().split(/\s{2,}/));
