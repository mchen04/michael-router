import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../src/config.js';
import {
  KEYS_HASH,
  createKeyResolver,
  decryptProviderKey,
  encryptProviderKey,
  isProviderId,
  validateProviderKey,
} from '../../src/keys.js';
import { ENV_KEYS, baseEnv, bearer } from '../helpers/fixtures.js';
import { makeHarness } from '../helpers/harness.js';

const KEK = Buffer.alloc(32, 9);
const STORE_KEY = 'sk-ant-fake-SENTINEL-store-claude-0002';

test('AES-256-GCM records: {v, iv, ct, tag, updated_at}; AAD binds the provider id', () => {
  const blob = encryptProviderKey(KEK, 'claude', STORE_KEY, '2026-10-21T00:00:00.000Z');
  const o = JSON.parse(blob);
  assert.deepEqual(Object.keys(o), ['v', 'iv', 'ct', 'tag', 'updated_at']);
  assert.equal(o.v, 1);
  assert.equal(Buffer.from(o.iv, 'base64url').length, 12);
  assert.equal(Buffer.from(o.tag, 'base64url').length, 16);
  assert.ok(!blob.includes(STORE_KEY) && !blob.includes('SENTINEL'));
  assert.deepEqual(decryptProviderKey(KEK, 'claude', blob), { key: STORE_KEY, updated_at: '2026-10-21T00:00:00.000Z' });
  assert.throws(() => decryptProviderKey(KEK, 'gemini', blob), 'wrong provider (AAD)');
  assert.throws(() => decryptProviderKey(Buffer.alloc(32, 8), 'claude', blob), 'wrong key-encryption key');
  const tampered = JSON.stringify({ ...o, ct: Buffer.from('x'.repeat(STORE_KEY.length)).toString('base64url') });
  assert.throws(() => decryptProviderKey(KEK, 'claude', tampered));
  assert.throws(() => decryptProviderKey(KEK, 'claude', '{"v":2}'));
  assert.throws(() => decryptProviderKey(KEK, 'claude', 'not json'));
  assert.notEqual(JSON.parse(encryptProviderKey(KEK, 'claude', STORE_KEY, 'x')).iv, o.iv, 'fresh IV per record');
});

test('key validation: 8-512 printable non-space ASCII; messages never contain the key', () => {
  assert.equal(validateProviderKey('12345678'), null);
  assert.equal(validateProviderKey('x'.repeat(512)), null);
  const bad = ['1234567', 'x'.repeat(513), 'abc defgh', 'abcdefgh\n', '\tabcdefgh', 'abcdéfghij', '', null, 42, undefined];
  for (const k of bad) {
    const problem = validateProviderKey(k);
    assert.ok(problem, String(k));
    if (typeof k === 'string' && k.length > 3) assert.ok(!problem.includes(k));
  }
  assert.match(String(validateProviderKey('abc defgh')), /whitespace/);
  assert.match(String(validateProviderKey('1234567')), /8 to 512/);
});

test('only the three provider ids are accepted (no aliases)', () => {
  for (const id of ['claude', 'gemini', 'openrouter']) assert.ok(isProviderId(id));
  for (const id of ['anthropic', 'Claude', 'CLAUDE', 'google', 'gemini ', 'open-router', 'or', '', 'constructor', '__proto__']) {
    assert.equal(isProviderId(id), false, id);
  }
});

test('resolver: store override beats env; env fallback; undecryptable record -> not configured, reported once', async () => {
  const config = loadConfig(await baseEnv(ENV_KEYS));
  const kek = /** @type {Buffer} */ (config.keyEncryptionKey);
  const resolver = createKeyResolver(config);
  const claudeBlob = encryptProviderKey(kek, 'claude', STORE_KEY, '2026-10-21T00:00:00.000Z');
  const geminiBlob = encryptProviderKey(kek, 'gemini', 'AIzaFAKE-SENTINEL-store-gemini-02', '2026-10-21T00:00:00.000Z');

  const envOnly = resolver.resolve([]);
  assert.deepEqual(envOnly.claude, { provider: 'claude', configured: true, source: 'env', updated_at: null, key: ENV_KEYS.ANTHROPIC_API_KEY });

  const stored = resolver.resolve(['claude', claudeBlob]);
  assert.equal(stored.claude.source, 'store');
  assert.equal(stored.claude.key, STORE_KEY);
  assert.equal(stored.claude.updated_at, '2026-10-21T00:00:00.000Z');
  assert.equal(stored.gemini.source, 'env');

  /** @type {string[]} */
  const reported = [];
  const swapped = ['claude', geminiBlob, 'gemini', claudeBlob];
  const r1 = resolver.resolve(swapped, (p) => reported.push(p));
  assert.deepEqual(r1.claude, { provider: 'claude', configured: false, source: 'none', updated_at: null, key: null });
  assert.equal(r1.gemini.configured, false);
  assert.equal(r1.openrouter.source, 'env');
  resolver.resolve(swapped, (p) => reported.push(p));
  assert.deepEqual(reported, ['claude', 'gemini'], 'reported once per instance per bad record');

  const noEnv = createKeyResolver(loadConfig(await baseEnv()));
  assert.equal(noEnv.resolve([]).claude.source, 'none');
});

test('keys over the handler: set, list (never values), unset, validation, aliases, unreachable verification', async () => {
  const h = await makeHarness({ env: { ANTHROPIC_API_KEY: ENV_KEYS.ANTHROPIC_API_KEY } });
  const put = (/** @type {string} */ provider, /** @type {unknown} */ body, raw = false) =>
    h.call(`/control/keys/${provider}`, { method: 'PUT', headers: bearer(), body: raw ? /** @type {string} */ (body) : JSON.stringify(body) });

  const list0 = await h.call('/control/keys', { headers: bearer() });
  assert.deepEqual(list0.json, [
    { provider: 'claude', configured: true, source: 'env', updated_at: null },
    { provider: 'gemini', configured: false, source: 'none', updated_at: null },
    { provider: 'openrouter', configured: false, source: 'none', updated_at: null },
  ]);

  const set = await put('claude', { key: STORE_KEY });
  assert.equal(set.status, 200);
  assert.deepEqual(Object.keys(set.json), ['provider', 'configured', 'source', 'updated_at']);
  assert.equal(set.json.source, 'store');
  assert.ok(!set.text.includes(STORE_KEY));
  const raw = h.store.exec(['HGETALL', KEYS_HASH]);
  assert.equal(raw[0], 'claude');
  assert.ok(!raw[1].includes(STORE_KEY));

  const list1 = await h.call('/control/keys', { headers: bearer() });
  assert.equal(list1.json[0].source, 'store');
  assert.ok(!list1.text.includes(STORE_KEY) && !list1.text.includes(ENV_KEYS.ANTHROPIC_API_KEY));

  const unverifiable = await put('openrouter', { key: 'sk-or-fake-SENTINEL-verify-0003', verify: true });
  assert.equal(unverifiable.status, 502, 'an unreachable provider: verification could not run');
  assert.deepEqual([unverifiable.json.error.code, unverifiable.json.error.type], ['key_verification_unavailable', 'upstream_error']);
  assert.match(unverifiable.json.error.message, /not stored/);
  assert.deepEqual(h.store.exec(['HGETALL', KEYS_HASH]).filter((/** @type {string} */ _, /** @type {number} */ i) => i % 2 === 0), ['claude'], 'nothing stored for openrouter');

  const unset = await h.call('/control/keys/claude', { method: 'DELETE', headers: bearer() });
  assert.deepEqual(unset.json, { provider: 'claude', configured: true, source: 'env', updated_at: null, removed: true });
  const unsetAgain = await h.call('/control/keys/claude', { method: 'DELETE', headers: bearer() });
  assert.equal(unsetAgain.json.removed, false);
  const unsetNone = await h.call('/control/keys/gemini', { method: 'DELETE', headers: bearer() });
  assert.equal(unsetNone.json.source, 'none');

  const invalid = [
    [{ key: 'short' }, 'invalid_key'],
    [{ key: 'x'.repeat(513) }, 'invalid_key'],
    [{ key: 'has a space-SENTINEL' }, 'invalid_key'],
    [{ key: 'trailing-newline-SENTINEL\n' }, 'invalid_key'],
    [{}, 'invalid_key'],
    [{ key: 12345678 }, 'invalid_key'],
    [{ key: 'valid-key-SENTINEL-0001', verify: 'yes' }, 'invalid_parameter'],
  ];
  for (const [body, code] of invalid) {
    const r = await put('gemini', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error.code, code);
    assert.ok(!r.text.includes('SENTINEL'), r.text);
  }
  for (const [body, code] of [
    ['not json', 'invalid_json'],
    ['["array"]', 'invalid_json'],
    ['null', 'invalid_json'],
  ]) {
    const r = await put('gemini', body, true);
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, code);
  }
  const big = await put('gemini', { key: 'k'.repeat(20000) });
  assert.equal(big.status, 413);
  assert.equal(big.json.error.code, 'payload_too_large');
  for (const alias of ['anthropic', 'Claude', 'google', 'OPENROUTER']) {
    const r = await put(alias, { key: 'valid-key-0001' });
    assert.equal(r.status, 400, alias);
    assert.equal(r.json.error.code, 'invalid_provider');
    const d = await h.call(`/control/keys/${alias}`, { method: 'DELETE', headers: bearer() });
    assert.equal(d.json.error.code, 'invalid_provider');
  }
  assert.equal(h.store.exec(['HGETALL', KEYS_HASH]).length, 0, 'claude was unset; the unverifiable openrouter key was never stored');
});

test('swapped records over the handler: not configured + gateway event, never a crash', async () => {
  const h = await makeHarness({ env: { ANTHROPIC_API_KEY: ENV_KEYS.ANTHROPIC_API_KEY } });
  const put = (/** @type {string} */ p, /** @type {string} */ key) =>
    h.call(`/control/keys/${p}`, { method: 'PUT', headers: bearer(), body: JSON.stringify({ key }) });
  await put('claude', STORE_KEY);
  await put('gemini', 'AIzaFAKE-SENTINEL-store-gemini-02');
  const [, claudeBlob, , geminiBlob] = h.store.exec(['HGETALL', KEYS_HASH]);
  h.store.exec(['HSET', KEYS_HASH, 'claude', geminiBlob, 'gemini', claudeBlob]);
  const list = await h.call('/control/keys', { headers: bearer() });
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.json.map((/** @type {any} */ k) => [k.provider, k.configured, k.source]),
    [
      ['claude', false, 'none'],
      ['gemini', false, 'none'],
      ['openrouter', false, 'none'],
    ],
  );
  await h.settle();
  const events = await h.call('/control/errors?kind=gateway', { headers: bearer() });
  const codes = events.json.map((/** @type {any} */ e) => `${e.code}:${e.provider}`).sort();
  assert.deepEqual(codes, ['provider_key_undecryptable:claude', 'provider_key_undecryptable:gemini']);
  assert.equal((await h.call('/control/health', { headers: bearer() })).json.providers.claude.configured, false);
});
