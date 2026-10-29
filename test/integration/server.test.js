// dev/server.js as a real process: landing page, security headers, misconfiguration.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ROUTER_SECRET, bearer, passwordHash } from '../helpers/fixtures.js';
import { startDevServer } from '../helpers/processes.js';

/** @type {Awaited<ReturnType<typeof startDevServer>>} */
let dev;
/** @type {Awaited<ReturnType<typeof startDevServer>>} */
let broken;

before(async () => {
  [dev, broken] = await Promise.all([
    startDevServer({ ROUTER_PASSWORD_HASH: await passwordHash(), ROUTER_SECRET, ROUTER_STORE: 'memory' }),
    startDevServer({ ROUTER_PASSWORD_HASH: 'scrypt$not-a-hash-SENTINEL', ROUTER_SECRET, ROUTER_STORE: 'memory' }),
  ]);
});
after(async () => {
  await Promise.all([dev?.stop(), broken?.stop()]);
});

test('landing page and robots.txt are public with the vercel.json security headers', async () => {
  const page = await fetch(`${dev.url}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Michael Router/);
  assert.match(String(page.headers.get('content-security-policy')), /^default-src 'none';.*frame-ancestors 'none'$/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('x-robots-tag'), 'noindex');
  assert.ok(page.headers.get('permissions-policy'));
  assert.match(await (await fetch(`${dev.url}/robots.txt`)).text(), /Disallow: \//);
});

test('misconfigured server: protected routes 503 naming the variable only; landing page still 200', async () => {
  for (const init of [{}, { headers: bearer() }]) {
    const res = await fetch(`${broken.url}/control/health`, init);
    assert.equal(res.status, init.headers ? 503 : 401);
    const text = await res.text();
    const { error } = JSON.parse(text);
    assert.equal(error.code, init.headers ? 'server_misconfigured' : 'missing_credentials');
    assert.equal(error.message.includes('ROUTER_PASSWORD_HASH'), Boolean(init.headers));
    assert.ok(!text.includes('SENTINEL'));
  }
  assert.equal((await fetch(`${broken.url}/`)).status, 200);
  assert.ok(!broken.output().stdout.includes('SENTINEL') && !broken.output().stderr.includes('SENTINEL'));
});
