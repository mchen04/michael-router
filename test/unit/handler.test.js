import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyPassword } from '../../src/auth.js';
import { routePath } from '../../src/handler.js';
import { VERSION } from '../../src/version.js';
import { PASSWORD, ROUTER_SECRET, WRONG_PASSWORD, baseEnv, bearer } from '../helpers/fixtures.js';
import { makeHarness } from '../helpers/harness.js';

/** @param {Headers} headers */
const corsHeaders = (headers) => [...headers.keys()].filter((k) => k.startsWith('access-control-'));

test('unknown /v1/* and /control/* paths: 401 without credentials, 404 with', async () => {
  const h = await makeHarness();
  for (const path of ['/v1/nope', '/control/nope', '/v1', '/control', '/v1/', '/control/keys/claude/extra', '/control/keys/']) {
    const anon = await h.call(path);
    assert.equal(anon.status, 401, path);
    assert.equal(anon.json.error.code, 'missing_credentials');
    const authed = await h.call(path, { headers: bearer() });
    assert.equal(authed.status, 404, path);
    assert.equal(authed.json.error.code, 'not_found');
  }
});

test('wrong method: 401 without credentials, 405 with Allow after auth', async () => {
  const h = await makeHarness();
  assert.equal((await h.call('/v1/chat/completions')).status, 401);
  const cases = [
    ['/v1/chat/completions', 'GET', 'POST'],
    ['/control/health', 'POST', 'GET'],
    ['/control/keys/claude', 'GET', 'PUT, DELETE'],
    ['/v1/models', 'OPTIONS', 'GET'],
  ];
  for (const [path, method, allow] of cases) {
    const r = await h.call(path, { method, headers: bearer() });
    assert.equal(r.status, 405, `${method} ${path}`);
    assert.equal(r.json.error.code, 'method_not_allowed');
    assert.equal(r.headers.get('allow'), allow);
  }
});

test('__route mapping on /api/router; the pathname otherwise', async () => {
  assert.equal(routePath(new URL('http://x/api/router?__route=v1/chat/completions')), '/v1/chat/completions');
  assert.equal(routePath(new URL('http://x/api/router?__route=control/keys/claude')), '/control/keys/claude');
  assert.equal(routePath(new URL('http://x/api/router')), null);
  assert.equal(routePath(new URL('http://x/control/health?__route=v1/models')), '/control/health');
  const h = await makeHarness();
  const health = await h.call('/api/router?__route=control/health', { headers: bearer() });
  assert.equal(health.status, 200);
  assert.equal(health.json.status, 'ok');
  const usage = await h.call('/api/router?__route=control/usage&days=2', { headers: bearer() });
  assert.equal(usage.status, 200);
  assert.equal(usage.json.days, 2);
  const put = await h.call('/api/router?__route=control/keys/gemini', {
    method: 'PUT',
    headers: bearer(),
    body: JSON.stringify({ key: 'AIzaFAKE-SENTINEL-via-rewrite-01' }),
  });
  assert.equal(put.status, 200);
  const models = await h.call('/api/router?__route=v1/models', { headers: bearer() });
  assert.equal(models.status, 200);
  assert.deepEqual([...new Set(models.json.data.map((/** @type {any} */ m) => m.owned_by))], ['gemini'], 'only the provider with a key is listed');
  assert.equal((await h.call('/api/router')).status, 401, 'the function path itself is protected');
  assert.equal((await h.call('/api/router', { headers: bearer() })).status, 404);
  assert.equal((await h.call('/api/router?__route=../etc/passwd', { headers: bearer() })).status, 404);
});

test('every handler response: Cache-Control no-store, unique request id, no CORS headers', async () => {
  const h = await makeHarness();
  const ids = new Set();
  const origin = { origin: 'https://evil.example', 'access-control-request-method': 'POST' };
  const requests = [
    ['/control/health', {}],
    ['/control/health', { headers: { ...bearer(), ...origin } }],
    ['/v1/chat/completions', { method: 'OPTIONS', headers: origin }],
    ['/v1/chat/completions', { method: 'OPTIONS', headers: { ...bearer(), ...origin } }],
    ['/nowhere', {}],
    ['/control/keys', { headers: bearer('wrong-SENTINEL-guess') }],
  ];
  for (const [path, init] of requests) {
    const r = await h.call(/** @type {string} */ (path), /** @type {RequestInit} */ (init));
    assert.equal(r.headers.get('cache-control'), 'no-store', String(path));
    const id = r.headers.get('x-router-request-id');
    assert.match(String(id), /^[0-9a-f-]{36}$/);
    ids.add(id);
    assert.deepEqual(corsHeaders(r.headers), []);
  }
  assert.equal(ids.size, requests.length);
});

test('misconfiguration: 503 server_misconfigured naming the variable only; no auth is attempted', async () => {
  const env = await baseEnv();
  const sentinelHash = 'scrypt$garbage-SENTINEL-hash-value';
  const sentinelSecret = 'short-SENTINEL-secret';
  const sentinelPlain = 'plain-SENTINEL-password';
  const cases = [
    [{ ...env, ROUTER_PASSWORD_HASH: undefined }, 'ROUTER_PASSWORD_HASH/ROUTER_PASSWORD'],
    [{ ...env, ROUTER_PASSWORD: sentinelPlain }, 'ROUTER_PASSWORD_HASH and ROUTER_PASSWORD are both set (set exactly one)'],
    [{ ...env, ROUTER_PASSWORD_HASH: undefined, ROUTER_PASSWORD: 'SENTINEL-pw' }, 'ROUTER_PASSWORD is missing or invalid'],
    [{ ...env, ROUTER_PASSWORD_HASH: sentinelHash }, 'ROUTER_PASSWORD_HASH'],
    [{ ...env, ROUTER_SECRET: undefined }, 'ROUTER_SECRET'],
    [{ ...env, ROUTER_SECRET: sentinelSecret }, 'ROUTER_SECRET'],
    [{ ...env, VERCEL: '1' }, 'ROUTER_STORE'],
    [{ ...env, NODE_ENV: 'production' }, 'ROUTER_STORE'],
    [{ ...env, ROUTER_STORE: undefined, VERCEL: '1' }, 'KV_REST_API_URL/KV_REST_API_TOKEN'],
  ];
  for (const [e, variable] of cases) {
    const h = await makeHarness({ env: /** @type {any} */ (e), rawEnv: true });
    for (const init of [{}, { headers: bearer() }]) {
      const r = await h.call('/control/health', init);
      assert.equal(r.status, 503);
      assert.equal(r.json.error.code, 'server_misconfigured');
      assert.ok(r.json.error.message.includes(/** @type {string} */ (variable)), r.json.error.message);
      for (const secret of [sentinelHash, sentinelSecret, sentinelPlain, 'SENTINEL-pw', PASSWORD, ROUTER_SECRET, env.ROUTER_PASSWORD_HASH]) {
        assert.ok(!r.text.includes(secret));
      }
    }
    assert.equal((await h.call('/v1/models', { headers: bearer() })).status, 503);
  }
});

test('ROUTER_PASSWORD (plaintext) server: correct password accepted, wrong one is a counted 401; never echoed', async () => {
  const { ROUTER_PASSWORD_HASH: _omit, ...env } = await baseEnv();
  const h = await makeHarness({ env: { ...env, ROUTER_PASSWORD: PASSWORD }, rawEnv: true });
  const ok = await h.call('/control/health', { headers: bearer() });
  assert.equal(ok.status, 200);
  const wrong = await h.call('/control/health', { headers: bearer(WRONG_PASSWORD) });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error.code, 'invalid_credentials');
  await h.settle();
  const events = await h.call('/control/errors?kind=auth', { headers: bearer() });
  assert.deepEqual(events.json.map((/** @type {any} */ e) => e.code), ['invalid_credentials']);
  for (const text of [ok.text, wrong.text, events.text, ...h.logs, JSON.stringify(h.store.dump())]) {
    assert.ok(!text.includes(PASSWORD) && !text.includes(WRONG_PASSWORD));
  }
});

test('successful control responses carry server-timing; x-router-cold and health report the cold first request', async () => {
  const h = await makeHarness({ env: { ANTHROPIC_API_KEY: 'sk-ant-fake-SENTINEL-health-0001', VERCEL_REGION: 'dev1' } });
  const first = await h.call('/control/health', { headers: bearer() });
  assert.equal(first.status, 200);
  assert.match(String(first.headers.get('server-timing')), /auth;dur=[\d.]+, store;dur=[\d.]+, gw;dur=[\d.]+/);
  assert.equal(first.headers.get('x-router-cold'), '1');
  assert.equal(first.json.version, VERSION);
  assert.equal(first.json.region, 'dev1');
  assert.equal(first.json.instance.cold, true);
  assert.equal(first.json.store.kind, 'memory');
  assert.equal(typeof first.json.store.latency_ms, 'number');
  assert.deepEqual(first.json.providers, { claude: { configured: true }, gemini: { configured: false }, openrouter: { configured: false } });
  assert.ok(!first.text.includes('sk-ant-fake-SENTINEL'));
  const second = await h.call('/control/health', { headers: bearer() });
  assert.equal(second.json.instance.cold, false);
  assert.equal(second.headers.has('x-router-cold'), false);
  // Unauthenticated responses never carry it, and an instance's first request is cold even then.
  const anon = await makeHarness();
  assert.equal((await anon.call('/control/health')).headers.has('x-router-cold'), false);
  assert.equal((await anon.call('/control/health', { headers: bearer() })).headers.has('x-router-cold'), false);
});

test('unexpected exceptions: 500 internal_error, logged as name + scrubbed message only', async () => {
  const h = await makeHarness({
    verifyPassword: async (/** @type {any} */ _parsed, /** @type {string} */ presented) => {
      throw new TypeError(`exploded while checking ${presented} with ${ROUTER_SECRET}`);
    },
  });
  const r = await h.call('/control/health', { headers: bearer() });
  assert.equal(r.status, 500);
  assert.equal(r.json.error.code, 'internal_error');
  const exception = h.logs.map((l) => JSON.parse(l)).find((l) => l.exception);
  assert.deepEqual(Object.keys(exception).sort(), ['exception', 'message', 'request_id']);
  assert.equal(exception.exception, 'TypeError');
  assert.ok(!exception.message.includes(PASSWORD) && !exception.message.includes(ROUTER_SECRET), exception.message);
  assert.ok(exception.message.includes('[redacted]'));
});

test('verifyPassword is the real scrypt verifier by default', async () => {
  let calls = 0;
  const h = await makeHarness({
    verifyPassword: async (/** @type {any} */ p, /** @type {string} */ s) => {
      calls++;
      return verifyPassword(p, s);
    },
  });
  assert.equal((await h.call('/control/health', { headers: bearer() })).status, 200);
  assert.equal((await h.call('/control/health', { headers: bearer() })).status, 200);
  assert.equal(calls, 1, 'second request hits the per-instance verified cache');
});
