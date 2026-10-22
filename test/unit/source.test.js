import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientAddress, normalizeAddress, resolveSource, sourceId } from '../../src/source.js';

test('normalizeAddress: IPv4 full address, IPv6 /64 prefix, mapped and odd forms', () => {
  const cases = [
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::ffff:cb00:7107', '203.0.113.7'],
    ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
    ['2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd', '2001:db8:1:2::/64'],
    ['[2001:db8:1:2::5]', '2001:db8:1:2::/64'],
    ['2001:db8:1:2:3:4:1.2.3.4', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8::/64'],
    ['2001:0:0:1::9', '2001:0:0:1::/64'],
    ['fe80::1%eth0', 'fe80::/64'],
    ['::1', '::/64'],
    ['not-an-ip', 'unknown'],
    ['01.2.3.4', 'unknown'],
    ['', 'unknown'],
    [undefined, 'unknown'],
    [null, 'unknown'],
  ];
  for (const [input, display] of cases) assert.equal(normalizeAddress(/** @type {any} */ (input)).display, display, String(input));
  assert.equal(normalizeAddress('::ffff:203.0.113.7').key, normalizeAddress('203.0.113.7').key);
});

test('source ids: same /64 shares a bucket, different /64 and IPv4 addresses do not', () => {
  const key = Buffer.alloc(32, 1);
  const id = (/** @type {string} */ a) => sourceId(key, normalizeAddress(a).key);
  assert.match(id('2001:db8:1:2::1'), /^[0-9a-f]{32}$/);
  assert.equal(id('2001:db8:1:2::1'), id('2001:db8:1:2:ffff:ffff:ffff:ffff'));
  assert.notEqual(id('2001:db8:1:2::1'), id('2001:db8:1:3::1'));
  assert.notEqual(id('198.51.100.1'), id('198.51.100.2'));
  assert.notEqual(sourceId(Buffer.alloc(32, 2), 'ipv4:198.51.100.1'), id('198.51.100.1'), 'keyed by ROUTER_SECRET');
});

test('clientAddress: socket unless trusted; trusted order x-vercel-forwarded-for then x-real-ip; x-forwarded-for ignored', () => {
  const req = new Request('http://localhost/', {
    headers: { 'x-vercel-forwarded-for': '198.51.100.9, 10.0.0.1', 'x-real-ip': '198.51.100.10', 'x-forwarded-for': '192.0.2.1' },
  });
  assert.equal(clientAddress(req, false, '127.0.0.1'), '127.0.0.1');
  assert.equal(clientAddress(req, true, '127.0.0.1'), '198.51.100.9');
  const realIp = new Request('http://localhost/', { headers: { 'x-real-ip': '198.51.100.10', 'x-forwarded-for': '192.0.2.1' } });
  assert.equal(clientAddress(realIp, true, undefined), '198.51.100.10');
  const xff = new Request('http://localhost/', { headers: { 'x-forwarded-for': '192.0.2.1' } });
  assert.equal(clientAddress(xff, true, undefined), null);
  assert.equal(clientAddress(xff, false, undefined), null);
  const config = { trustProxyHeaders: true, sourceKey: Buffer.alloc(32, 3) };
  assert.equal(resolveSource(xff, config, undefined).display, 'unknown');
  assert.equal(resolveSource(req, config, undefined).display, '198.51.100.9');
});
