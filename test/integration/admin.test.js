import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROUTES } from '../../src/handler.js';
import { baseEnv, bearer, passwordHash, PASSWORD, WRONG_PASSWORD } from '../helpers/fixtures.js';
import { makeHarness } from '../helpers/harness.js';

const ADMIN = 'owner-SENTINEL-admin-password';
const adminEnv = async (extra = {}) => ({ ...await baseEnv(), ROUTER_ADMIN_PASSWORD_HASH: await passwordHash(ADMIN), ...extra });

test('every control route and rewrite rejects the shared user password without counting a failure', async () => {
  const h = await makeHarness({ env: await adminEnv({ AUTH_MAX_FAILURES: '1' }) });
  for (const route of ROUTES.filter((route) => route.path.startsWith('/control/'))) {
    const path = route.path.replace(':provider', 'openai');
    for (const target of [path, `/api/router?__route=${path.slice(1)}`]) {
      const response = await h.call(target, { method: route.method, headers: bearer(PASSWORD), body: ['PUT', 'POST'].includes(route.method) ? '{}' : undefined });
      assert.equal(response.status, 403, target);
      assert.equal(response.json.error.code, 'admin_required');
    }
  }
  await h.settle();
  assert.equal((await h.call('/control/health', { headers: bearer(ADMIN) })).status, 200);
  assert.equal(h.store.dump().auth_sources.length, 0);
});

test('admin may use every control route and either credential may use v1', async () => {
  const h = await makeHarness({ env: await adminEnv() });
  for (const route of ROUTES.filter((route) => route.path.startsWith('/control/'))) {
    const result = await h.call(route.path.replace(':provider', 'openai'), { method: route.method, headers: bearer(ADMIN), body: route.method === 'PUT' ? JSON.stringify({ key: 'fake-admin-key' }) : undefined });
    assert.equal(result.status, 200, route.path);
  }
  for (const password of [PASSWORD, ADMIN]) assert.equal((await h.call('/v1/models', { headers: bearer(password) })).status, 200);
});

test('missing or malformed admin configuration fails closed without disabling user v1 access', async () => {
  for (const extra of [{ ROUTER_ADMIN_PASSWORD_HASH: '' }, { ROUTER_ADMIN_PASSWORD_HASH: 'bad-hash' }, { ROUTER_ADMIN_PASSWORD: 'too-short', ROUTER_ADMIN_PASSWORD_HASH: '' }, { ROUTER_ADMIN_PASSWORD: ADMIN }]) {
    const h = await makeHarness({ env: await adminEnv(extra) });
    const response = await h.call('/control/keys', { headers: bearer(PASSWORD) });
    assert.equal(response.status, 503);
    assert.equal(response.json.error.code, 'server_misconfigured');
    assert.match(response.json.error.message, /ROUTER_ADMIN_PASSWORD/);
    assert.equal((await h.call('/v1/models', { headers: bearer(PASSWORD) })).status, 200);
  }
});

test('wrong admin attempts share the limiter with user attempts, while user control refusals do not count', async () => {
  const h = await makeHarness({ env: await adminEnv({ AUTH_MAX_FAILURES: '1' }) });
  assert.equal((await h.call('/control/keys', { headers: bearer(PASSWORD) })).status, 403);
  assert.equal((await h.call('/control/keys', { headers: bearer(WRONG_PASSWORD) })).status, 401);
  assert.equal((await h.call('/v1/models', { headers: bearer(PASSWORD) })).status, 429);
  assert.equal((await h.call('/control/health', { headers: bearer(ADMIN) })).status, 429);
});

test('plaintext admin password accepts one trailing newline and never appears in state or logs', async () => {
  const h = await makeHarness({ env: await adminEnv({ ROUTER_ADMIN_PASSWORD_HASH: '', ROUTER_ADMIN_PASSWORD: `${ADMIN}\n` }) });
  assert.equal((await h.call('/control/health', { headers: bearer(ADMIN) })).status, 200);
  await h.settle();
  for (const text of [...h.logs, JSON.stringify(h.store.dump())]) assert.ok(!text.includes(ADMIN));
});

test('reusing the shared user password as admin never grants control access', async () => {
  const h = await makeHarness({ env: await adminEnv({ ROUTER_ADMIN_PASSWORD_HASH: await passwordHash(PASSWORD) }) });
  assert.equal((await h.call('/control/keys', { headers: bearer(PASSWORD) })).status, 403);
});
