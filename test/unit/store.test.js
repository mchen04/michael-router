import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startFakeUpstash } from '../../dev/fake-upstash.js';
import { StoreError, failClosed } from '../../src/store/index.js';
import { createMemoryStore } from '../../src/store/memory.js';
import { createUpstashStore } from '../../src/store/upstash.js';
import { STORE_TOKEN, fakeClock } from '../helpers/fixtures.js';
import { startRedirectTrap } from '../helpers/redirect-trap.js';

test('memory store: strings, counters, TTL semantics (TTL/PTTL -2/-1, EXPIRE, SET PX/EX/NX)', () => {
  const clock = fakeClock();
  const s = createMemoryStore({ now: clock.now });
  assert.equal(s.exec(['PING']), 'PONG');
  assert.equal(s.exec(['GET', 'k']), null);
  assert.equal(s.exec(['INCR', 'c']), 1, 'INCR on a missing key');
  assert.equal(s.exec(['DECR', 'd']), -1);
  assert.equal(s.exec(['GET', 'c']), '1', 'values come back as strings');
  assert.equal(s.exec(['TTL', 'missing']), -2);
  assert.equal(s.exec(['PTTL', 'c']), -1);
  assert.equal(s.exec(['EXPIRE', 'c', 10]), 1);
  assert.equal(s.exec(['TTL', 'c']), 10);
  assert.equal(s.exec(['INCR', 'c']), 2);
  assert.equal(s.exec(['TTL', 'c']), 10, 'INCR preserves the TTL');
  assert.equal(s.exec(['EXPIRE', 'missing', 10]), 0);
  clock.advance(9500);
  assert.equal(s.exec(['PTTL', 'c']), 500);
  assert.equal(s.exec(['TTL', 'c']), 1, 'TTL rounds like Redis');
  clock.advance(500);
  assert.equal(s.exec(['GET', 'c']), null, 'expired');
  assert.equal(s.exec(['TTL', 'c']), -2);
  assert.equal(s.exec(['INCR', 'c']), 1, 'counter restarts after expiry');

  assert.equal(s.exec(['SET', 'w', '1', 'PX', 250]), 'OK');
  assert.equal(s.exec(['PTTL', 'w']), 250);
  assert.equal(s.exec(['SET', 'w', '2', 'NX']), null);
  assert.equal(s.exec(['SET', 'b', 'v', 'EX', 2]), 'OK');
  assert.equal(s.exec(['TTL', 'b']), 2);
  assert.equal(s.exec(['SET', 'b', 'v2']), 'OK');
  assert.equal(s.exec(['TTL', 'b']), -1, 'plain SET clears the TTL');
  assert.equal(s.exec(['EXPIRE', 'b', 0]), 1);
  assert.equal(s.exec(['GET', 'b']), null, 'EXPIRE 0 deletes');
  assert.equal(s.exec(['DEL', 'w', 'n', 'c']), 2, 'only existing keys count');
  assert.throws(() => s.exec(['SET', 'x', 'v', 'EX', 0]), /invalid expire time/);
  assert.throws(() => s.exec(['SET', 'x', 'v', 'BOGUS']), /syntax error/);
  s.exec(['SET', 'str', 'abc']);
  assert.throws(() => s.exec(['INCR', 'str']), /not an integer/);
  assert.throws(() => s.exec(['HGETALL', 'str']), /WRONGTYPE/);
});

test('memory store: hashes and lists', () => {
  const s = createMemoryStore();
  assert.deepEqual(s.exec(['HGETALL', 'h']), []);
  assert.equal(s.exec(['HSET', 'h', 'a', '1', 'b', '2']), 2);
  assert.equal(s.exec(['HSET', 'h', 'a', '3']), 0);
  assert.deepEqual(s.exec(['HGETALL', 'h']), ['a', '3', 'b', '2'], 'flat array');
  assert.equal(s.exec(['HINCRBY', 'h', 'n', 5]), 5);
  assert.equal(s.exec(['HINCRBY', 'h', 'n', -2]), 3);
  assert.throws(() => s.exec(['HINCRBY', 'h', 'n', 'x']), /not an integer/);
  assert.equal(s.exec(['HDEL', 'h', 'a', 'zz']), 1);
  assert.equal(s.exec(['HDEL', 'h', 'b', 'n']), 2);
  assert.equal(s.exec(['TTL', 'h']), -2, 'empty hash is deleted');
  assert.throws(() => s.exec(['HSET', 'h', 'a']), /wrong number of arguments/);

  for (let i = 0; i < 5; i++) s.exec(['LPUSH', 'l', `v${i}`]);
  assert.deepEqual(s.exec(['LRANGE', 'l', 0, -1]), ['v4', 'v3', 'v2', 'v1', 'v0']);
  assert.deepEqual(s.exec(['LRANGE', 'l', 1, 2]), ['v3', 'v2']);
  assert.deepEqual(s.exec(['LRANGE', 'l', -2, 100]), ['v1', 'v0']);
  assert.deepEqual(s.exec(['LRANGE', 'l', 7, 9]), []);
  assert.equal(s.exec(['LTRIM', 'l', 0, 2]), 'OK');
  assert.deepEqual(s.exec(['LRANGE', 'l', 0, -1]), ['v4', 'v3', 'v2']);
  assert.equal(s.exec(['LPUSH', 'l', 'a', 'b']), 5);
  assert.deepEqual(s.exec(['LRANGE', 'l', 0, 1]), ['b', 'a']);
  assert.equal(s.exec(['LTRIM', 'l', 5, 10]), 'OK');
  assert.equal(s.exec(['TTL', 'l']), -2, 'trimmed to empty -> deleted');
  assert.deepEqual(s.exec(['LRANGE', 'nolist', 0, -1]), []);
});

test('memory store: unknown commands and wrong arity are errors', () => {
  const s = createMemoryStore();
  assert.throws(() => s.exec(['FLUSHALL']), /unknown command/);
  assert.throws(() => s.exec(['GET']), /wrong number of arguments for 'get'/);
  assert.throws(() => s.exec([]), /invalid command/);
  assert.throws(() => s.exec(['GET', { a: 1 }]), /invalid command/);
});

test('fake Upstash: REST shapes, auth, unknown command 400, pipeline errors inline, multi-exec discard', async () => {
  const fake = await startFakeUpstash({ token: STORE_TOKEN });
  try {
    const post = async (/** @type {string} */ path, /** @type {unknown} */ body, token = STORE_TOKEN) => {
      const res = await fetch(fake.url + path, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    assert.deepEqual(await post('/', ['INCR', 'n']), { status: 200, body: { result: 1 } });
    assert.deepEqual(await post('/', ['GET', 'n']), { status: 200, body: { result: '1' } });
    assert.deepEqual(await post('/', ['GET', 'none']), { status: 200, body: { result: null } });
    assert.equal((await post('/', ['INCR', 'n'], 'wrong')).status, 401);
    const unknown = await post('/', ['NOPE']);
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /unknown command/);
    const pipe = await post('/pipeline', [['SET', 's', 'x'], ['INCR', 's'], ['HSET', 'h', 'f', 'v'], ['HGETALL', 'h']]);
    assert.equal(pipe.status, 200);
    assert.equal(pipe.body[0].result, 'OK');
    assert.match(pipe.body[1].error, /not an integer/);
    assert.deepEqual(pipe.body.slice(2), [{ result: 1 }, { result: ['f', 'v'] }]);
    const multi = await post('/multi-exec', [['SET', 'm', '0', 'EX', 60, 'NX'], ['INCR', 'm'], ['DECR', 'm']]);
    assert.deepEqual(multi.body, [{ result: 'OK' }, { result: 1 }, { result: 0 }]);
    const again = await post('/multi-exec', [['SET', 'm', '0', 'EX', 60, 'NX'], ['INCR', 'm'], ['DECR', 'm']]);
    assert.deepEqual(again.body, [{ result: null }, { result: 1 }, { result: 0 }], 'SET NX leaves the existing counter');
    assert.equal(fake.store.exec(['TTL', 'm']), 60, 'INCR/DECR keep the TTL set by SET EX');
    const discarded = await post('/multi-exec', [['INCR', 'm'], ['BOGUS']]);
    assert.equal(discarded.status, 400);
    assert.match(discarded.body.error, /EXECABORT/);
    assert.equal(fake.store.exec(['GET', 'm']), '0', 'discarded transaction ran nothing');
    const dump = await fetch(`${fake.url}/__dump`, { headers: { authorization: `Bearer ${STORE_TOKEN}` } });
    assert.equal(dump.status, 404, 'dump only with --debug-dump');
    const get = await fetch(fake.url, { headers: { authorization: `Bearer ${STORE_TOKEN}` } });
    assert.equal(get.status, 405);
  } finally {
    await fake.close();
  }
});

test('Upstash client against the fake: command, pipeline, multi; failures and timeouts are StoreErrors', async () => {
  const fake = await startFakeUpstash({ token: STORE_TOKEN, debugDump: true });
  const failing = await startFakeUpstash({ token: STORE_TOKEN, fail: true });
  const slow = await startFakeUpstash({ token: STORE_TOKEN, delayMs: 400 });
  try {
    const client = failClosed(createUpstashStore({ url: `${fake.url}/`, token: STORE_TOKEN }));
    assert.equal(await client.command(['INCR', 'x']), 1);
    assert.deepEqual(await client.pipeline([['GET', 'x'], ['PTTL', 'x'], ['HGETALL', 'none']]), ['1', -1, []]);
    assert.deepEqual(await client.multi([['INCR', 'x'], ['DECR', 'x']]), [2, 1]);
    await assert.rejects(client.pipeline([['GET', 'x'], ['NOPE']]), StoreError);
    await assert.rejects(client.multi([['NOPE']]), StoreError);
    await assert.rejects(client.command(['NOPE']), StoreError);
    const dump = await (await fetch(`${fake.url}/__dump`, { headers: { authorization: `Bearer ${STORE_TOKEN}` } })).json();
    assert.deepEqual(dump.x, { type: 'string', value: '1', ttl_ms: -1 });
    assert.equal((await fetch(`${fake.url}/__dump`)).status, 401);

    const badToken = failClosed(createUpstashStore({ url: fake.url, token: 'wrong-token' }));
    await assert.rejects(badToken.command(['PING']), (/** @type {any} */ e) => e instanceof StoreError && !e.message.includes('wrong-token'));
    await assert.rejects(failClosed(createUpstashStore({ url: failing.url, token: STORE_TOKEN })).command(['PING']), StoreError);
    await assert.rejects(failClosed(createUpstashStore({ url: 'http://127.0.0.1:1', token: STORE_TOKEN })).command(['PING']), StoreError);
    const t = performance.now();
    await assert.rejects(failClosed(createUpstashStore({ url: slow.url, token: STORE_TOKEN }), 150).command(['PING']), /timed out/);
    assert.ok(performance.now() - t < 390);
    await assert.rejects(failClosed(createUpstashStore({ url: slow.url, token: STORE_TOKEN, timeoutMs: 150 })).command(['PING']), /timed out/);
  } finally {
    await Promise.all([fake.close(), failing.close(), slow.close()]);
  }
});

test('Upstash client never follows a redirect: a 307 to another origin is a StoreError and the token never arrives there', async () => {
  const trap = await startRedirectTrap();
  try {
    const client = failClosed(createUpstashStore({ url: trap.url, token: STORE_TOKEN }));
    await assert.rejects(client.command(['GET', 'k']), StoreError);
    await assert.rejects(client.pipeline([['GET', 'k']]), StoreError);
    assert.deepEqual(trap.received, []);
  } finally {
    await trap.close();
  }
});
