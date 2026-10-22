import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SCRYPT,
  bearerCredential,
  createAuthenticator,
  hashPassword,
  parsePasswordHash,
  verifyPassword,
} from '../../src/auth.js';
import { FAST_SCRYPT, PASSWORD, WRONG_PASSWORD } from '../helpers/fixtures.js';

test('hashPassword creates a scrypt$ hash that verifies only the right password', async () => {
  const hash = await hashPassword(PASSWORD, FAST_SCRYPT);
  assert.match(hash, /^scrypt\$10\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.ok(!hash.includes(PASSWORD));
  const parsed = parsePasswordHash(hash);
  assert.ok(parsed);
  assert.equal(await verifyPassword(parsed, PASSWORD), true);
  assert.equal(await verifyPassword(parsed, WRONG_PASSWORD), false);
  assert.equal(await verifyPassword(parsed, `${PASSWORD} `), false);
  assert.notEqual(await hashPassword(PASSWORD, FAST_SCRYPT), hash, 'random salt');
});

test('default scrypt parameters are logN 15, r 8, p 1', async () => {
  assert.deepEqual({ ...DEFAULT_SCRYPT }, { logN: 15, r: 8, p: 1 });
  const hash = await hashPassword(PASSWORD);
  assert.match(hash, /^scrypt\$15\$8\$1\$/);
  assert.equal(await verifyPassword(/** @type {any} */ (parsePasswordHash(hash)), PASSWORD), true);
});

test('hashPassword rejects empty passwords and out-of-range parameters', async () => {
  await assert.rejects(hashPassword(''), TypeError);
  await assert.rejects(hashPassword(PASSWORD, { logN: 9, r: 8, p: 1 }), RangeError);
  await assert.rejects(hashPassword(PASSWORD, { logN: 18, r: 8, p: 1 }), RangeError);
});

test('parsePasswordHash rejects missing and malformed values', async () => {
  const good = await hashPassword(PASSWORD, FAST_SCRYPT);
  const [, , , , salt, hash] = good.split('$');
  const bad = [
    undefined,
    '',
    PASSWORD,
    'scrypt$10$8$1$onlyfive',
    `bcrypt$10$8$1$${salt}$${hash}`,
    `scrypt$9$8$1$${salt}$${hash}`,
    `scrypt$18$8$1$${salt}$${hash}`,
    `scrypt$10$0$1$${salt}$${hash}`,
    `scrypt$10$8$5$${salt}$${hash}`,
    `scrypt$10$17$1$${salt}$${hash}`,
    `scrypt$010$8$1$${salt}$${hash}`,
    `scrypt$10$8$1$c2FsdA$${hash}`,
    `scrypt$10$8$1$${salt}$aGFzaA`,
    `scrypt$10$8$1$${salt}+$${hash}`,
    `${good}\n`,
    ` ${good}`,
  ];
  for (const value of bad) assert.equal(parsePasswordHash(value), null, String(value));
  assert.ok(parsePasswordHash(good));
});

test('authenticator caches only verified credentials, at most 4', async () => {
  const parsed = /** @type {any} */ (parsePasswordHash(await hashPassword(PASSWORD, FAST_SCRYPT)));
  let calls = 0;
  const auth = createAuthenticator({
    passwordHash: parsed,
    verifyPassword: async (p, presented) => {
      calls++;
      return verifyPassword(p, presented);
    },
  });
  assert.equal(await auth.check(WRONG_PASSWORD), false);
  assert.equal(await auth.check(WRONG_PASSWORD), false);
  assert.equal(calls, 2, 'wrong credentials are never cached');
  assert.equal(await auth.check(PASSWORD), true);
  assert.equal(await auth.check(PASSWORD), true);
  assert.equal(calls, 3, 'second correct check is a cache hit');
});

test('plaintext ROUTER_PASSWORD mode: exact match only, compared as HMAC digests, scrypt never runs', async () => {
  let calls = 0;
  const auth = createAuthenticator({
    password: PASSWORD,
    verifyPassword: async () => {
      calls++;
      return true;
    },
  });
  for (const wrong of [WRONG_PASSWORD, PASSWORD.slice(0, -1), `${PASSWORD}x`, PASSWORD.toUpperCase(), ` ${PASSWORD}`]) {
    assert.equal(await auth.check(wrong), false, wrong);
  }
  assert.equal(await auth.check(PASSWORD), true);
  assert.equal(await auth.check(PASSWORD), true);
  assert.equal(calls, 0);
  const parsed = /** @type {any} */ (parsePasswordHash(await hashPassword(PASSWORD, FAST_SCRYPT)));
  assert.throws(() => createAuthenticator({}), TypeError);
  assert.throws(() => createAuthenticator({ passwordHash: parsed, password: PASSWORD }), TypeError);
});

test('bearerCredential accepts only Authorization: Bearer', () => {
  const req = (/** @type {string | undefined} */ value) =>
    new Request('http://localhost/', value === undefined ? {} : { headers: { authorization: value } });
  assert.equal(bearerCredential(req(undefined)), null);
  assert.equal(bearerCredential(req('')), null);
  assert.equal(bearerCredential(req('Bearer')), null);
  assert.equal(bearerCredential(req('Bearer    ')), null);
  assert.equal(bearerCredential(req(`Basic ${Buffer.from('a:b').toString('base64')}`)), null);
  assert.equal(bearerCredential(req(PASSWORD)), null);
  assert.equal(bearerCredential(req(`Bearer ${PASSWORD}`)), PASSWORD);
  assert.equal(bearerCredential(req(`bearer ${PASSWORD}`)), PASSWORD);
  assert.equal(bearerCredential(req('Bearer pass word')), 'pass word');
});
