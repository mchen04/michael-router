// scripts/live-smoke.mjs against the local dev server with the memory store and fake providers
// (mocked evidence, labelled as such by the script because the target is loopback).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { containsPassword } from '../../scripts/live-smoke.mjs';
import { SMOKE_MODELS } from '../../src/pricing.js';
import { ADMIN_PASSWORD, PASSWORD, ROUTER_SECRET, passwordHash } from '../helpers/fixtures.js';
import { SECRET_MARKER, startRouterStack } from '../helpers/cli.js';
import { emptySocketDir } from '../helpers/postgres.js';
import { startDevServer } from '../helpers/processes.js';
import { startRedirectTrap } from '../helpers/redirect-trap.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/live-smoke.mjs', import.meta.url));
const CALL_FIELDS = ['cost', 'finish_reason', 'http_status', 'mode', 'model', 'ok', 'provider', 'reply', 'result', 'router_headers', 'server_timing', 'total_ms', 'ttfb_ms', 'usage'];

/** @type {string} */
let dir;
/** @type {Awaited<ReturnType<typeof emptySocketDir>>} */
let noServer;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'live-smoke-'));
  noServer = await emptySocketDir();
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
  await noServer?.remove();
});

/**
 * @param {string} url @param {string} name @param {{password?: string, args?: string[]}} [options]
 * @returns {Promise<{code: number | null, stdout: string, stderr: string, out: string}>}
 */
function runSmoke(url, name, { password = PASSWORD, adminPassword = ADMIN_PASSWORD, args = [] } = {}) {
  const out = path.join(dir, `${name}.json`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, '--url', url, '--out', out, '--providers', 'claude,gemini,openrouter', ...args], { env: { HOME: dir, MR_ADMIN_PASSWORD: adminPassword }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.stdin.end(`${password}\n`);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('live-smoke timed out'));
    }, 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, out });
    });
  });
}

test('records every check with only the allowed fields, labelled as mocked, and never the password', async () => {
  const stack = await startRouterStack();
  try {
    // Default fake replies carry no tool call: the claude tool-call check must fail. By default
    // no wrong password is sent.
    const plain = await runSmoke(stack.url, 'plain');
    assert.equal(plain.code, 1, plain.stderr);
    const plainEv = JSON.parse(await readFile(plain.out, 'utf8'));
    assert.deepEqual(
      plainEv.calls.filter((/** @type {any} */ c) => !c.ok).map((/** @type {any} */ c) => `${c.provider} ${c.mode} ${c.result}`),
      ['claude tool-call no_tool_call'],
    );
    assert.deepEqual(Object.keys(plainEv.control), ['health', 'keys', 'user_control', 'usage', 'errors', 'unauthenticated']);
    assert.ok(!plainEv.control.errors.events.some((/** @type {any} */ e) => e.code === 'invalid_credentials'), 'a wrong password was sent');

    stack.fake.setDefaults({ scenario: 'ok-tools' });
    const r = await runSmoke(stack.url, 'tools', { args: ['--probe-wrong-password'] });
    assert.equal(r.code, 0, r.stderr);
    const ev = JSON.parse(await readFile(r.out, 'utf8'));
    assert.equal(ev.target.live, false);
    assert.match(ev.result, /^PASS \(14 checks\)$/);
    assert.deepEqual(
      ev.calls.map((/** @type {any} */ c) => `${c.provider} ${c.mode}`),
      ['claude non-stream', 'claude stream', 'claude tool-call', 'gemini non-stream', 'gemini stream', 'openrouter non-stream', 'openrouter stream'],
    );
    const geminiModels = stack.fake.requests.filter((q) => q.provider === 'gemini' && q.method === 'POST').map((q) => q.body?.model);
    assert.deepEqual([...new Set(geminiModels)], [SMOKE_MODELS.gemini], 'the Gemini checks send the Gemini smoke model');
    for (const c of ev.calls) {
      assert.deepEqual(Object.keys(c).sort(), CALL_FIELDS);
      assert.equal(c.http_status, 200);
      assert.equal(c.router_headers['x-router-provider'], c.provider);
      assert.ok(c.router_headers['x-router-request-id']);
      assert.match(c.server_timing, /gw;dur=/);
      assert.ok(c.usage.prompt_tokens > 0 && c.ttfb_ms >= 0 && c.total_ms >= c.ttfb_ms);
      assert.ok(['exact', 'estimated', 'unknown'].includes(c.cost.status));
      assert.ok(c.reply.length <= 60);
    }
    const tool = ev.calls.find((/** @type {any} */ c) => c.mode === 'tool-call');
    assert.equal(tool.finish_reason, 'tool_calls');
    assert.match(tool.reply, /get_time/);
    const openrouter = ev.calls.find((/** @type {any} */ c) => c.provider === 'openrouter' && c.mode === 'non-stream');
    assert.equal(openrouter.cost.status, 'exact');

    assert.deepEqual(Object.keys(ev.control), ['health', 'keys', 'user_control', 'usage', 'errors', 'unauthenticated', 'wrong_password']);
    for (const [name, check] of Object.entries(ev.control)) assert.equal(/** @type {any} */ (check).result, 'ok', name);
    assert.deepEqual(ev.control.keys.keys.map((/** @type {any} */ k) => k.provider), ['claude', 'gemini', 'openrouter', 'openai']);
    for (const e of ev.control.errors.events) assert.ok(!('message' in e) && !('source' in e));

    const md = await readFile(r.out.replace(/\.json$/, '.md'), 'utf8');
    assert.match(md, /local target: mocked evidence, not a live deployment/);
    assert.match(md, /\| claude \| claude-[^|]+ \| tool-call \| 200 \| ok \|/);
    for (const text of [r.stdout, r.stderr, plain.stdout, plain.stderr, JSON.stringify(ev), JSON.stringify(plainEv), md]) {
      assert.ok(!text.includes(SECRET_MARKER), 'a fixture secret reached the output or the evidence');
    }
  } finally {
    await stack.stop();
  }
});

test('a missing store, an unreachable store and a redirect are reported distinctly, with exit 3', async () => {
  const base = { ROUTER_PASSWORD_HASH: await passwordHash(), ROUTER_SECRET };
  const noStore = await startDevServer(base);
  // A unix-socket directory with no server in it: every connection attempt fails at once.
  const nowhere = encodeURIComponent(noServer.dir);
  const deadStore = await startDevServer({ ...base, DATABASE_URL: `postgresql://router@localhost/router?host=${nowhere}` });
  const trap = await startRedirectTrap();
  try {
    const missing = await runSmoke(noStore.url, 'no-store');
    assert.equal(missing.code, 3);
    assert.match(missing.stderr, /Authentication unavailable \(503 server_misconfigured\)/);
    assert.match(missing.stderr, /Check password, secret and database settings/);
    const missingEv = JSON.parse(await readFile(missing.out, 'utf8'));
    assert.equal(missingEv.result, 'NOT USABLE: server_misconfigured');
    assert.deepEqual(missingEv.calls, [], 'nothing else is sent');

    const unavailable = await runSmoke(deadStore.url, 'dead-store');
    assert.equal(unavailable.code, 3);
    assert.match(unavailable.stderr, /store unavailable \(503 store_unavailable\)/);
    assert.equal(JSON.parse(await readFile(unavailable.out, 'utf8')).result, 'NOT USABLE: store_unavailable');

    const redirected = await runSmoke(trap.url, 'redirect');
    assert.equal(redirected.code, 3);
    assert.match(redirected.stderr, /cannot reach .* \(redirect_refused\)/);
    assert.deepEqual(trap.received, [], 'the password never followed the redirect');
    for (const r of [missing, unavailable, redirected]) assert.ok(!(r.stdout + r.stderr).includes(SECRET_MARKER));

    // An unexpected error (here: the evidence cannot be written) has its own exit code.
    await writeFile(path.join(dir, 'not-a-dir'), '');
    const broken = await runSmoke(noStore.url, 'broken', { args: ['--out', path.join(dir, 'not-a-dir', 'x.json')] });
    assert.equal(broken.code, 5, broken.stderr);
    assert.match(broken.stderr, /^live-smoke: unexpected error \([A-Z]+\); the evidence and summary may be missing or incomplete$/m);
  } finally {
    await Promise.all([noStore.stop(), deadStore.stop(), trap.close()]);
  }
});

test('a reply that overlaps the password is dropped; evidence or progress that contains it is never written', async () => {
  // The fake providers' replies contain this password: the reply snippets are dropped and the
  // evidence is written without them.
  const echoed = 'Hello from the fake';
  let stack = await startRouterStack({ ROUTER_PASSWORD_HASH: '', ROUTER_PASSWORD: echoed });
  try {
    const r = await runSmoke(stack.url, 'overlap', { password: echoed });
    assert.equal(r.code, 1, r.stderr);
    const json = await readFile(r.out, 'utf8');
    const md = await readFile(r.out.replace(/\.json$/, '.md'), 'utf8');
    assert.ok(JSON.parse(json).calls.every((c) => c.reply === null || c.reply.startsWith('[redacted]')));
    for (const text of [json, md, r.stdout, r.stderr]) assert.ok(!text.includes('Hello from'), 'part of the password was written');
  } finally {
    await stack.stop();
  }

  // A password equal to a result code: the progress line is withheld and nothing is written.
  const code = 'scripts/live-smoke.mjs';
  stack = await startRouterStack({ ROUTER_PASSWORD_HASH: '', ROUTER_PASSWORD: code, GEMINI_API_KEY: '' });
  try {
    const r = await runSmoke(stack.url, 'leak', { password: code });
    assert.equal(r.code, 4, r.stderr);
    assert.match(r.stderr, /aborted: the evidence contains the router password; nothing was written/);
    assert.ok(!(r.stdout + r.stderr).includes(code), 'the password reached the terminal');
    assert.ok(!(await readdir(dir)).some((f) => f.startsWith('leak')));
  } finally {
    await stack.stop();
  }
});

test('the leak check finds the password in any evidence string, also where JSON or markdown escape it', () => {
  const password = 'pw"with|pipe\\and-slash';
  const ev = { calls: [{ finish_reason: password }] };
  const md = `| ${password.replace(/\|/g, '\\|')} |`;
  assert.equal(containsPassword(password, ev, JSON.stringify(ev), md), true, 'raw string value');
  assert.equal(containsPassword(password, {}, JSON.stringify(ev)), true, 'JSON-escaped text');
  assert.equal(containsPassword(password, {}, md), true, 'markdown-escaped text');
  assert.equal(containsPassword(password, { calls: [{ reply: 'pw"with' }] }, '{}'), false);
});

test('smoke requires a separate admin source before contacting the router', async () => {
  const stack = await startRouterStack();
  try {
    const result = await runSmoke(stack.url, 'missing-admin', { adminPassword: '' });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /MR_ADMIN_PASSWORD/);
    assert.equal(stack.fake.requests.length, 0);
  } finally {
    await stack.stop();
  }
});
