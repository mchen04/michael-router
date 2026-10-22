import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EVENTS_KEY, appendEvent, buildEvent, listEvents } from '../../src/events.js';
import { failClosed } from '../../src/store/index.js';
import { createMemoryStore } from '../../src/store/memory.js';
import { PASSWORD, WRONG_PASSWORD, bearer } from '../helpers/fixtures.js';
import { makeHarness } from '../helpers/harness.js';

test('auth failures are recorded with the display source (IPv4 address or IPv6 /64)', async () => {
  const h = await makeHarness({ env: { TRUST_PROXY_HEADERS: '1' } });
  const wrong = (/** @type {string} */ ip) => h.call('/control/health', { headers: { ...bearer(WRONG_PASSWORD), 'x-vercel-forwarded-for': ip } });
  await wrong('203.0.113.9');
  await wrong('2001:db8:aa:bb:1:2:3:4');
  await h.settle();
  const r = await h.call('/control/errors?kind=auth', { headers: bearer() });
  assert.equal(r.status, 200);
  assert.equal(r.json.length, 2);
  const [newest, oldest] = r.json;
  assert.deepEqual(Object.keys(oldest), ['ts', 'kind', 'code', 'status', 'message', 'source', 'request_id']);
  assert.equal(oldest.message, 'Wrong password.');
  assert.equal(oldest.source, '203.0.113.9');
  assert.equal(newest.source, '2001:db8:aa:bb::/64');
  assert.equal(newest.code, 'invalid_credentials');
  assert.equal(newest.status, 401);
  assert.match(newest.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(!r.text.includes(WRONG_PASSWORD) && !r.text.includes(PASSWORD));
});

test('the failure that triggers a block says so; pre-auth rejections are not recorded', async () => {
  const h = await makeHarness({ env: { AUTH_MAX_FAILURES: '2', AUTH_BACKOFF_BASE_MS: '1', AUTH_BACKOFF_MAX_MS: '1' } });
  await h.call('/control/health', { headers: bearer(WRONG_PASSWORD) });
  await new Promise((r) => setTimeout(r, 5));
  await h.call('/control/health', { headers: bearer(WRONG_PASSWORD) });
  await h.call('/control/health', { headers: bearer(WRONG_PASSWORD) }); // 429, not recorded
  await h.call('/control/health'); // 401 missing_credentials, not recorded
  await h.settle();
  const events = await listEvents(failClosed(h.store));
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => e.message),
    ['Wrong password; the source is blocked for 3600 s.', 'Wrong password.'],
  );
});

test('gateway errors after authentication are recorded; kind filter and limit', async () => {
  const h = await makeHarness();
  await h.call('/control/nope', { headers: bearer() });
  await h.call('/control/health', { method: 'POST', headers: bearer() });
  await h.call('/control/errors?limit=0', { headers: bearer() });
  await h.call('/control/health', { headers: bearer(WRONG_PASSWORD) });
  await h.settle();
  const all = await h.call('/control/errors', { headers: bearer() });
  assert.deepEqual(
    all.json.map((/** @type {any} */ e) => `${e.kind}:${e.code}:${e.status}`),
    ['auth:invalid_credentials:401', 'gateway:invalid_parameter:400', 'gateway:method_not_allowed:405', 'gateway:not_found:404'],
  );
  assert.ok(all.json.every((/** @type {any} */ e) => e.kind === 'auth' || !('source' in e)), 'source only on auth events');
  const gw = await h.call('/control/errors?kind=gateway&limit=2', { headers: bearer() });
  assert.deepEqual(gw.json.map((/** @type {any} */ e) => e.code), ['invalid_parameter', 'method_not_allowed']);
  for (const q of ['kind=bogus', 'limit=201', 'limit=x']) {
    const bad = await h.call(`/control/errors?${q}`, { headers: bearer() });
    assert.equal(bad.status, 400, q);
  }
});

test('LTRIM keeps the newest 200 events', async () => {
  const store = failClosed(createMemoryStore());
  for (let i = 0; i < 250; i++) await appendEvent(store, { ts: 't', kind: 'gateway', code: `c${i}`, status: 500, request_id: String(i) });
  const raw = await store.command(['LRANGE', EVENTS_KEY, 0, -1]);
  assert.equal(raw.length, 200);
  const listed = await listEvents(store, { limit: 200 });
  assert.equal(listed[0].code, 'c249');
  assert.equal(listed[199].code, 'c50');
  assert.equal((await listEvents(store)).length, 50, 'default limit');
});

test('buildEvent keeps allowlisted metadata only, with a static message by code, and source only for auth', () => {
  const opts = { scrub: (/** @type {unknown} */ s) => String(s), now: () => 0, requestId: 'r1' };
  const input = /** @type {any} */ ({ kind: 'upstream', code: 'provider_error', status: 502, upstream_status: 500, provider: 'claude', model: 'claude-x' });
  const e = buildEvent({ ...input, message: 'quoted request text', detail: 'more text', source: '1.2.3.4' }, opts);
  assert.deepEqual(e, {
    ts: '1970-01-01T00:00:00.000Z',
    kind: 'upstream',
    code: 'provider_error',
    status: 502,
    upstream_status: 500,
    provider: 'claude',
    model: 'claude-x',
    message: 'The provider failed or answered with something unusable.',
    request_id: 'r1',
  });
  const message = (/** @type {any} */ extra) => buildEvent({ ...input, ...extra }, opts).message;
  assert.equal(message({ code: 'overloaded_error', status: 529, upstream_status: 529 }), 'The provider answered HTTP 529.');
  assert.equal(message({ code: 'overloaded_error', status: 200, upstream_status: undefined }), 'The provider reported an error inside the stream.');
  assert.equal(message({ kind: 'gateway', code: 'other_code', status: 400 }), 'Request refused.');
});
