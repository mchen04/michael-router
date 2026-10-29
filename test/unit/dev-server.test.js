// The node:http <-> Web Request/Response adapter: per-chunk streaming, request bodies,
// client-disconnect aborts, waitUntil tracking, static files with the vercel.json headers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { SECURITY_HEADERS, startDevServer } from '../../dev/server.js';

test('responses stream chunk by chunk; request bodies arrive; socket address is passed', async () => {
  /** @type {any} */
  let seen;
  const dev = await startDevServer({
    port: 0,
    handler: async (request, platform) => {
      seen = { method: request.method, body: request.body ? await request.text() : null, platform, url: request.url };
      let n = 0;
      const stream = new ReadableStream({
        async pull(controller) {
          if (n === 2) return controller.close();
          if (n === 1) await new Promise((r) => setTimeout(r, 400));
          controller.enqueue(new TextEncoder().encode(`data: ${n++}\n\n`));
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  try {
    const body = 'x'.repeat(256 * 1024);
    const t0 = performance.now();
    const res = await fetch(`${dev.url}/v1/chat/completions?a=1`, { method: 'POST', body });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const reader = /** @type {ReadableStreamDefaultReader<Uint8Array>} */ (res.body?.getReader());
    const first = await reader.read();
    const tFirst = performance.now() - t0;
    assert.equal(new TextDecoder().decode(first.value), 'data: 0\n\n');
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    const tAll = performance.now() - t0;
    assert.equal(rest, 'data: 1\n\n');
    assert.ok(tFirst < tAll - 250, `first chunk flushed early (${tFirst.toFixed(0)} ms vs ${tAll.toFixed(0)} ms)`);
    assert.equal(seen.method, 'POST');
    assert.equal(seen.body.length, body.length);
    assert.equal(new URL(seen.url).search, '?a=1');
    assert.match(seen.platform.remoteAddress, /127\.0\.0\.1/);
    assert.equal(typeof seen.platform.waitUntil, 'function');
  } finally {
    await dev.close();
  }
});

test('client disconnect aborts request.signal and cancels the response stream; waitUntil is awaited on close', async () => {
  /** @type {(v: string) => void} */
  let reportAbort = () => {};
  const aborted = new Promise((resolve) => (reportAbort = resolve));
  let cancelled = false;
  let backgroundDone = false;
  const dev = await startDevServer({
    port: 0,
    handler: async (request, /** @type {any} */ platform) => {
      request.signal.addEventListener('abort', () => reportAbort('aborted'));
      platform.waitUntil(new Promise((r) => setTimeout(r, 200)).then(() => (backgroundDone = true)));
      const timer = { id: /** @type {any} */ (null) };
      return new Response(
        new ReadableStream({
          start(controller) {
            timer.id = setInterval(() => controller.enqueue(new TextEncoder().encode('data: tick\n\n')), 20);
          },
          cancel() {
            cancelled = true;
            clearInterval(timer.id);
          },
        }),
      );
    },
  });
  try {
    const ac = new AbortController();
    const res = await fetch(`${dev.url}/v1/chat/completions`, { method: 'POST', body: '{}', signal: ac.signal });
    const reader = /** @type {ReadableStreamDefaultReader<Uint8Array>} */ (res.body?.getReader());
    await reader.read();
    ac.abort();
    const outcome = await Promise.race([aborted, new Promise((r) => setTimeout(() => r('timeout'), 2000))]);
    assert.equal(outcome, 'aborted');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(cancelled, true);
  } finally {
    await dev.close();
  }
  assert.equal(backgroundDone, true, 'close() waits for tracked waitUntil promises');
});

test('a client that leaves before the handler returns still gets the response stream cancelled', async () => {
  /** @type {(v: string) => void} */
  let reportCancel = () => {};
  const cancelled = new Promise((resolve) => (reportCancel = resolve));
  const dev = await startDevServer({
    port: 0,
    handler: async (request) => {
      await new Promise((resolve) => request.signal.addEventListener('abort', resolve, { once: true }));
      return new Response(
        new ReadableStream({
          pull: (controller) => controller.enqueue(new Uint8Array(1)),
          cancel: () => reportCancel('cancelled'),
        }),
      );
    },
  });
  try {
    const ac = new AbortController();
    const pending = fetch(`${dev.url}/v1/chat/completions`, { method: 'POST', body: '{}', signal: ac.signal }).catch(() => 'aborted');
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    assert.equal(await pending, 'aborted');
    assert.equal(await Promise.race([cancelled, new Promise((r) => setTimeout(() => r('timeout'), 2000))]), 'cancelled');
  } finally {
    await dev.close();
  }
});

test('static files from public/ with the same security headers as vercel.json; API paths go to the handler', async () => {
  /** @type {string[]} */
  const handled = [];
  const dev = await startDevServer({
    port: 0,
    handler: async (request) => {
      handled.push(new URL(request.url).pathname);
      return new Response('api');
    },
  });
  try {
    const expectedHeaders = Object.fromEntries(JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'))
      .headers.find((rule) => rule.source === '/(.*)').headers.map(({ key, value }) => [key.toLowerCase(), value]));
    assert.deepEqual(SECURITY_HEADERS, expectedHeaders);
    const documents = readdirSync(new URL('../../public/docs/', import.meta.url), { recursive: true })
      .filter((file) => file.endsWith('.html')).map((file) => [`/docs/${file}`, 'text/html; charset=utf-8']);
    const resources = [['/', 'text/html; charset=utf-8'], ...documents,
      ['/AGENTS.md', 'application/octet-stream'], ['/llms.txt', 'text/plain; charset=utf-8'],
      ['/style.css', 'text/css; charset=utf-8'], ['/app.js', 'text/javascript; charset=utf-8'], ['/favicon.svg', 'image/svg+xml']];
    for (const [resource, contentType] of resources) {
      const response = await fetch(dev.url + resource);
      assert.equal(response.status, 200, resource);
      assert.equal(response.headers.get('content-type'), contentType, resource);
      for (const [key, value] of Object.entries(expectedHeaders)) assert.equal(response.headers.get(key), value, `${resource}: ${key}`);
      const body = await response.text();
      if (resource === '/') {
        assert.match(body, /<h1[^>]*>Four providers\.<br>One connection\.<\/h1>/);
        assert.match(body, /<title>Four providers, one private API \| Michael Router<\/title>/);
      } else if (resource.endsWith('.html')) assert.match(body, /<h1[^>]*>[^<]+<\/h1>/, resource);
      else assert.ok(body.length > 0, resource);
    }
    assert.deepEqual(handled, [], 'static files bypass the API handler');
    assert.match(SECURITY_HEADERS['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(SECURITY_HEADERS['x-robots-tag'], 'noindex');
    assert.equal((await fetch(`${dev.url}/robots.txt`)).status, 200);
    assert.equal((await fetch(`${dev.url}/nope.html`)).status, 404);
    assert.equal((await fetch(`${dev.url}/%2e%2e/package.json`)).status, 404);
    assert.equal((await fetch(`${dev.url}/..%2fpackage.json`)).status, 404);
    assert.equal((await fetch(`${dev.url}/`, { method: 'POST' })).status, 405);
    for (const p of ['/v1/models', '/control', '/control/health', '/api/router']) assert.equal(await (await fetch(dev.url + p)).text(), 'api');
    assert.equal(await (await fetch(`${dev.url}/v1x`)).status, 404, '/v1x is not an API path');
    assert.deepEqual(handled, ['/v1/models', '/control', '/control/health', '/api/router']);
  } finally {
    await dev.close();
  }
});
