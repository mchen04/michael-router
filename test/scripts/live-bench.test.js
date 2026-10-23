// bench/live.mjs against the local dev server with the memory store and fake providers (mocked
// evidence, labelled as such by the script because the target is loopback).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { containsPassword } from '../../scripts/live-smoke.mjs';
import { SMOKE_MODELS } from '../../src/pricing.js';
import { SECRET_MARKER, startRouterStack } from '../helpers/cli.js';
import { PASSWORD } from '../helpers/fixtures.js';

const SCRIPT = fileURLToPath(new URL('../../bench/live.mjs', import.meta.url));

/** @type {string} */
let dir;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'live-bench-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** @param {string[]} args @returns {Promise<{code: number | null, stdout: string, stderr: string}>} */
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { HOME: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.stdin.on('error', () => {});
    child.stdin.end(`${PASSWORD}\n`);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('live bench timed out'));
    }, 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('refuses more than 30 requests per provider, and gaps under 2 s to a deployed router, before sending anything', async () => {
  const many = await run(['--url', 'https://router.invalid', '--n', '31', '--out', path.join(dir, 'refused.json')]);
  assert.equal(many.code, 2);
  assert.match(many.stderr, /refusing --n 31: at most 30 requests per provider/);
  const fast = await run(['--url', 'https://router.invalid', '--gap-ms', '1999', '--out', path.join(dir, 'refused.json')]);
  assert.equal(fast.code, 2);
  assert.match(fast.stderr, /--gap-ms must be at least 2000/);
  assert.deepEqual(await readdir(dir), [], 'nothing written');
});

test('records client total, server-timing and the cold flag per request; overhead = total - upstream; never the password', async () => {
  const stack = await startRouterStack();
  try {
    const out = path.join(dir, 'live.json');
    const r = await run(['--url', stack.url, '--n', '2', '--health-n', '3', '--gap-ms', '0', '--out', out]);
    assert.equal(r.code, 0, r.stderr);
    const ev = JSON.parse(await readFile(out, 'utf8'));
    const md = await readFile(path.join(dir, 'live.md'), 'utf8');
    assert.equal(ev.target.live, false);
    assert.match(ev.result, /^PASS \(9 requests\)$/);
    assert.deepEqual(ev.config.providers_measured, ['claude', 'gemini', 'openrouter']);
    assert.deepEqual(
      ev.requests.map((/** @type {any} */ q) => [q.kind, q.provider ?? null, q.cold]),
      [
        ['health', null, true],
        ...[1, 2].flatMap(() => [['health', null, false], ['chat', 'claude', false], ['chat', 'gemini', false], ['chat', 'openrouter', false]]),
      ],
      'the first request is the cold one; health and chat requests interleave',
    );
    const geminiModels = stack.fake.requests.filter((q) => q.provider === 'gemini' && q.method === 'POST').map((q) => q.body?.model);
    assert.deepEqual(geminiModels, [SMOKE_MODELS.gemini, SMOKE_MODELS.gemini], 'the Gemini requests send the Gemini smoke model');
    for (const q of ev.requests) {
      assert.equal(q.result, 'ok');
      assert.ok(q.total_ms >= q.ttfb_ms && typeof q.server_timing.gw === 'number' && typeof q.server_timing.store === 'number');
      if (q.kind === 'chat') {
        assert.ok(Math.abs(q.overhead_ms - (q.total_ms - q.server_timing.upstream)) < 0.01);
        assert.ok(Math.abs(q.in_router_ms - (q.server_timing.gw - q.server_timing.upstream)) < 0.01);
      }
    }
    assert.deepEqual([ev.summary.health.n, ev.summary.health.cold, ev.summary.claude.ok], [3, 1, 2]);
    assert.match(md, /local target: mocked evidence/);
    for (const text of [JSON.stringify(ev), md, r.stdout, r.stderr]) {
      assert.ok(!containsPassword(PASSWORD, null, text) && !text.includes(SECRET_MARKER));
    }
  } finally {
    await stack.stop();
  }
});
