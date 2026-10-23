// Provider keys over HTTP against a real dev server on Postgres, inspecting the stored records.
import assert from 'node:assert/strict';
import { createDecipheriv, hkdfSync } from 'node:crypto';
import { after, before, test } from 'node:test';
import { ENV_KEYS, ROUTER_SECRET, bearer, passwordHash } from '../helpers/fixtures.js';
import { migrate, startPostgres, withClient } from '../helpers/postgres.js';
import { startDevServer } from '../helpers/processes.js';

const CLAUDE_KEY = 'sk-ant-fake-SENTINEL-http-claude-0005';
const GEMINI_KEY = 'AIzaFAKE-SENTINEL-http-gemini-06';

/** @type {Awaited<ReturnType<typeof startDevServer>>} */
let dev;
/** @type {Awaited<ReturnType<typeof startPostgres>>} */
let cluster;
/** @type {string} */
let url;

before(async () => {
  cluster = await startPostgres();
  url = await cluster.createDatabase('keys');
  await migrate(url);
  dev = await startDevServer({
    ROUTER_PASSWORD_HASH: await passwordHash(),
    ROUTER_SECRET,
    DATABASE_URL: url,
    ANTHROPIC_API_KEY: ENV_KEYS.ANTHROPIC_API_KEY,
  });
});
after(async () => {
  await dev?.stop();
  await cluster?.stop();
});

/** @param {string} path @param {RequestInit} [init] */
async function api(path, init = {}) {
  const res = await fetch(dev.url + path, { ...init, headers: { ...bearer(), ...init.headers } });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
}

/** Decrypt a stored record independently of src/keys.js, following DESIGN §4/§6. */
function decrypt(/** @type {string} */ provider, /** @type {string} */ blob) {
  const kek = Buffer.from(hkdfSync('sha256', Buffer.from(ROUTER_SECRET, 'base64url'), Buffer.alloc(0), 'provider-keys-v1', 32));
  const o = JSON.parse(blob);
  const d = createDecipheriv('aes-256-gcm', kek, Buffer.from(o.iv, 'base64url'));
  d.setAAD(Buffer.from(provider));
  d.setAuthTag(Buffer.from(o.tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(o.ct, 'base64url')), d.final()]).toString('utf8');
}

test('set / list / unset over HTTP; records are AES-256-GCM ciphertext bound to the provider id', async () => {
  const initial = await api('/control/keys');
  assert.deepEqual(initial.json[0], { provider: 'claude', configured: true, source: 'env', updated_at: null });

  for (const [provider, key] of [
    ['claude', CLAUDE_KEY],
    ['gemini', GEMINI_KEY],
  ]) {
    const put = await api(`/control/keys/${provider}`, { method: 'PUT', body: JSON.stringify({ key }) });
    assert.equal(put.status, 200);
    assert.ok(!put.text.includes(key));
  }
  const list = await api('/control/keys');
  assert.deepEqual(
    list.json.map((/** @type {any} */ k) => [k.provider, k.configured, k.source]),
    [
      ['claude', true, 'store'],
      ['gemini', true, 'store'],
      ['openrouter', false, 'none'],
    ],
  );
  assert.ok(!list.text.includes('SENTINEL'), 'list never returns values');

  const { rows } = await withClient(url, (c) => c.query('SELECT provider, record, updated_at FROM michael_router.provider_keys ORDER BY provider'));
  assert.deepEqual(rows.map((r) => r.provider), ['claude', 'gemini']);
  assert.ok(rows.every((r) => r.updated_at instanceof Date && r.updated_at.toISOString() === JSON.parse(r.record).updated_at));
  const stored = Object.fromEntries(rows.map((r) => [r.provider, r.record]));
  assert.ok(!JSON.stringify(rows).includes('SENTINEL'), 'only ciphertext in the store');
  assert.equal(decrypt('claude', stored.claude), CLAUDE_KEY);
  assert.equal(decrypt('gemini', stored.gemini), GEMINI_KEY);
  assert.throws(() => decrypt('gemini', stored.claude), 'AAD = provider id');

  const unset = await api('/control/keys/claude', { method: 'DELETE' });
  assert.equal(unset.json.source, 'env', 'falls back to the env key');
  assert.equal((await api('/control/keys/gemini', { method: 'DELETE' })).json.source, 'none');
});
