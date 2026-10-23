import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROVIDER_IDS, loadConfig } from '../../src/config.js';
import { ENV_KEYS, ROUTER_SECRET, baseEnv } from '../helpers/fixtures.js';

test('a complete dev configuration has no problems and is frozen', async () => {
  const config = loadConfig(await baseEnv());
  assert.deepEqual([...config.problems], []);
  assert.deepEqual(config.store, { kind: 'memory' });
  assert.equal(config.production, false);
  assert.equal(config.trustProxyHeaders, false);
  assert.equal(config.keyEncryptionKey?.length, 32);
  assert.equal(config.sourceKey?.length, 32);
  assert.notDeepEqual(config.keyEncryptionKey, config.sourceKey);
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.limiter) && Object.isFrozen(config.providers.claude));
  assert.deepEqual([...PROVIDER_IDS], ['claude', 'gemini', 'openrouter']);
});

test('missing or malformed ROUTER_PASSWORD_HASH and ROUTER_SECRET are reported by name', async () => {
  const env = await baseEnv();
  assert.deepEqual([...loadConfig({ ...env, ROUTER_PASSWORD_HASH: '' }).problems], ['ROUTER_PASSWORD_HASH/ROUTER_PASSWORD']);
  assert.deepEqual([...loadConfig({ ...env, ROUTER_PASSWORD_HASH: 'hunter2' }).problems], ['ROUTER_PASSWORD_HASH']);
  const { ROUTER_SECRET: _omit, ...noSecret } = env;
  assert.deepEqual([...loadConfig(noSecret).problems], ['ROUTER_SECRET']);
  assert.deepEqual([...loadConfig({ ...env, ROUTER_SECRET: Buffer.alloc(31, 7).toString('base64') }).problems], ['ROUTER_SECRET']);
  assert.deepEqual([...loadConfig({ ...env, ROUTER_SECRET: 'not base64 at all!' }).problems], ['ROUTER_SECRET']);
  assert.deepEqual([...loadConfig({ ...env, ROUTER_SECRET: Buffer.alloc(32, 7).toString('base64') }).problems], []);
});

test('exactly one of ROUTER_PASSWORD_HASH or ROUTER_PASSWORD (>= 12 characters); the plaintext is a scrubbed secret', async () => {
  const { ROUTER_PASSWORD_HASH: hash, ...noHash } = await baseEnv();
  const plain = loadConfig({ ...noHash, ROUTER_PASSWORD: 'twelve-chars' });
  assert.deepEqual([...plain.problems], []);
  assert.equal(plain.password, 'twelve-chars');
  assert.equal(plain.passwordHash, null);
  assert.ok(plain.secrets.includes('twelve-chars'));
  assert.deepEqual([...loadConfig({ ...noHash, ROUTER_PASSWORD: 'eleven-char' }).problems], ['ROUTER_PASSWORD']);
  assert.deepEqual([...loadConfig(noHash).problems], ['ROUTER_PASSWORD_HASH/ROUTER_PASSWORD']);
  const both = loadConfig({ ...noHash, ROUTER_PASSWORD_HASH: hash, ROUTER_PASSWORD: 'twelve-chars' });
  assert.deepEqual([...both.problems], ['ROUTER_PASSWORD_HASH', 'ROUTER_PASSWORD']);
  assert.equal(both.passwordConflict, true);
  assert.ok(both.secrets.includes('twelve-chars') && both.secrets.includes(hash));
  assert.equal(loadConfig({ ...noHash, ROUTER_PASSWORD_HASH: hash }).passwordConflict, false);
});

test('exactly one trailing newline (\\n or \\r\\n) on ROUTER_PASSWORD_HASH or ROUTER_PASSWORD is ignored', async () => {
  const { ROUTER_PASSWORD_HASH: hash, ...noHash } = await baseEnv();
  for (const eol of ['\n', '\r\n']) {
    const hashed = loadConfig({ ...noHash, ROUTER_PASSWORD_HASH: hash + eol });
    assert.deepEqual([...hashed.problems], []);
    assert.ok(hashed.passwordHash);
    assert.equal(loadConfig({ ...noHash, ROUTER_PASSWORD: `twelve-chars${eol}` }).password, 'twelve-chars');
  }
  assert.deepEqual([...loadConfig({ ...noHash, ROUTER_PASSWORD_HASH: `${hash}\n\n` }).problems], ['ROUTER_PASSWORD_HASH']);
  assert.equal(loadConfig({ ...noHash, ROUTER_PASSWORD: 'twelve-chars\n\n' }).password, 'twelve-chars\n');
});

test('ROUTER_STORE=memory is refused when VERCEL is set or NODE_ENV=production', async () => {
  const env = await baseEnv();
  assert.ok(loadConfig({ ...env, VERCEL: '1' }).problems.includes('ROUTER_STORE'));
  assert.ok(loadConfig({ ...env, NODE_ENV: 'production' }).problems.includes('ROUTER_STORE'));
  assert.ok(loadConfig({ ...env, ROUTER_STORE: 'redis' }).problems.includes('ROUTER_STORE'));
});

test('store configuration: DATABASE_URL_POOLED, else DATABASE_URL; TLS required off loopback; URLs and passwords are secrets', async () => {
  const { ROUTER_STORE: _omit, ...env } = await baseEnv();
  const prod = { ...env, VERCEL: '1' };
  const params = '?sslmode=require&channel_binding=require';
  const pooled = `postgresql://router:db-pw-SENTINEL-pooled@db-pooler.example.test/router${params}`;
  const direct = `postgresql://router:db%40pw-SENTINEL-direct@db.example.test/router${params}`;
  assert.deepEqual([...loadConfig(prod).problems], ['DATABASE_URL_POOLED/DATABASE_URL']);
  assert.deepEqual([...loadConfig(env).problems], ['DATABASE_URL_POOLED/DATABASE_URL'], 'no silent memory fallback');

  const both = loadConfig({ ...prod, DATABASE_URL_POOLED: pooled, DATABASE_URL: direct });
  assert.deepEqual([...both.problems], []);
  assert.deepEqual(both.store, {
    kind: 'postgres',
    envName: 'DATABASE_URL_POOLED',
    connectionString: 'postgresql://router:db-pw-SENTINEL-pooled@db-pooler.example.test/router',
    ssl: true,
    channelBinding: true,
  });
  for (const secret of [pooled, direct, 'db-pw-SENTINEL-pooled', 'db%40pw-SENTINEL-direct', 'db@pw-SENTINEL-direct']) {
    assert.ok(both.secrets.includes(secret), secret);
  }
  assert.equal(loadConfig({ ...prod, DATABASE_URL: direct }).store?.envName, 'DATABASE_URL');

  const problems = (/** @type {Record<string, string>} */ e, /** @type {string} */ url) => [...loadConfig({ ...e, DATABASE_URL: url }).problems];
  const remote = 'postgresql://router:pw@db.example.test/router';
  for (const query of ['', '?sslmode=disable', '?sslmode=allow', '?sslmode=prefer', '?sslmode=no-verify']) {
    assert.deepEqual(problems(prod, remote + query), ['DATABASE_URL'], `production refuses "${query}"`);
    assert.deepEqual(problems(env, remote + query), ['DATABASE_URL'], `a remote host needs TLS in development too: "${query}"`);
  }
  for (const query of ['?sslmode=verify-full', '?sslmode=verify-ca&channel_binding=disable']) assert.deepEqual(problems(prod, remote + query), []);
  assert.equal(loadConfig({ ...prod, DATABASE_URL: `${remote}?sslmode=require&channel_binding=disable` }).store?.channelBinding, false);
  for (const query of ['?sslmode=require&sslrootcert=/x.pem', '?sslmode=require&ssl=true', '?sslmode=require&uselibpqcompat=true', '?sslmode=require&channel_binding=maybe']) {
    assert.deepEqual(problems(prod, remote + query), ['DATABASE_URL'], `pg would override the TLS settings: "${query}"`);
  }
  for (const url of ['https://db.example.test/router?sslmode=require', 'not a url', 'postgresql://[bad/router']) {
    assert.deepEqual(problems(prod, url), ['DATABASE_URL']);
    assert.ok(loadConfig({ ...prod, DATABASE_URL: url }).secrets.includes(url), 'a refused value is still scrubbed');
  }
  // Production: the URL itself names the host, user and password (pg would take a missing one
  // from PGHOST, PGUSER or PGPASSWORD).
  for (const url of ['postgresql:///router?sslmode=require', 'postgresql://:pw@db.example.test/router?sslmode=require', 'postgresql://router@db.example.test/router?sslmode=require']) {
    assert.deepEqual(problems(prod, url), ['DATABASE_URL'], url);
    assert.deepEqual([...loadConfig({ ...prod, DATABASE_URL_POOLED: url }).problems], ['DATABASE_URL_POOLED'], url);
  }

  // Development (tests): loopback hosts and unix-socket directories may skip TLS; production never.
  const socket = 'postgresql://router@localhost/router?host=%2Fvar%2Frun%2Fpostgresql';
  for (const url of [socket, 'postgresql://router@127.0.0.1:5433/router', 'postgres://router@[::1]/router?sslmode=disable', 'postgresql://router@localhost/router']) {
    const c = loadConfig({ ...env, DATABASE_URL: url });
    assert.deepEqual([...c.problems], [], url);
    assert.deepEqual([c.store?.kind, /** @type {any} */ (c.store).ssl, /** @type {any} */ (c.store).channelBinding], ['postgres', false, false], url);
    assert.deepEqual(problems(prod, url), ['DATABASE_URL'], url);
  }
  assert.deepEqual(problems(env, `${socket}&channel_binding=require`), ['DATABASE_URL'], 'channel binding needs TLS');
  assert.equal(/** @type {any} */ (loadConfig({ ...env, DATABASE_URL: socket }).store).connectionString, socket);
});

test('limiter tunables: defaults, overrides, invalid values named', async () => {
  const env = await baseEnv();
  assert.deepEqual(
    { ...loadConfig(env).limiter },
    { maxFailures: 8, windowSeconds: 3600, blockSeconds: 3600, maxInflight: 32, backoffBaseMs: 250, backoffMaxMs: 30000 },
  );
  const c = loadConfig({ ...env, AUTH_MAX_FAILURES: '3', AUTH_MAX_INFLIGHT: '5', AUTH_BACKOFF_BASE_MS: '10' });
  assert.equal(c.limiter.maxFailures, 3);
  assert.equal(c.limiter.maxInflight, 5);
  assert.equal(c.limiter.backoffBaseMs, 10);
  for (const bad of ['0', '-1', 'abc', '1.5', '99999999999']) {
    assert.ok(loadConfig({ ...env, AUTH_MAX_FAILURES: bad }).problems.includes('AUTH_MAX_FAILURES'), bad);
  }
  assert.ok(loadConfig({ ...env, AUTH_BLOCK_SECONDS: '86401' }).problems.includes('AUTH_BLOCK_SECONDS'));
});

test('provider env keys and base URL overrides are validated by name', async () => {
  const env = await baseEnv(ENV_KEYS);
  const c = loadConfig(env);
  assert.deepEqual([...c.problems], []);
  assert.equal(c.providers.claude.envKey, ENV_KEYS.ANTHROPIC_API_KEY);
  assert.equal(c.providers.gemini.baseUrl, 'https://generativelanguage.googleapis.com');
  assert.ok(c.secrets.includes(ENV_KEYS.OPENROUTER_API_KEY) && c.secrets.includes(ROUTER_SECRET));
  assert.deepEqual([...loadConfig({ ...env, GEMINI_API_KEY: 'has space inside' }).problems], ['GEMINI_API_KEY']);
  assert.deepEqual([...loadConfig({ ...env, ANTHROPIC_BASE_URL: 'ftp://x' }).problems], ['ANTHROPIC_BASE_URL']);
  assert.equal(loadConfig({ ...env, OPENROUTER_BASE_URL: 'http://127.0.0.1:9999/' }).providers.openrouter.baseUrl, 'http://127.0.0.1:9999');
});

test('proxy-header trust, region and commit', async () => {
  const env = await baseEnv();
  assert.equal(loadConfig({ ...env, TRUST_PROXY_HEADERS: '1' }).trustProxyHeaders, true);
  assert.equal(loadConfig({ ...env, TRUST_PROXY_HEADERS: '0' }).trustProxyHeaders, false);
  const c = loadConfig({ ...env, VERCEL_REGION: 'iad1', VERCEL_GIT_COMMIT_SHA: 'ABCDEF0123456789abcdef0123456789abcdef01' });
  assert.equal(c.region, 'iad1');
  assert.equal(c.commit, 'abcdef0');
  assert.equal(loadConfig(env).commit, null);
});
