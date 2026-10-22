// Streaming over real HTTP (dev/server.js adapter in-process) against the fake providers:
// incremental relay and client-disconnect propagation to the upstream.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { startFakeProviders } from '../../dev/fake-providers.js';
import { startDevServer } from '../../dev/server.js';
import { createHandler } from '../../src/handler.js';
import { ENV_KEYS, OFFLINE_BASE_URLS, baseEnv, bearer } from '../helpers/fixtures.js';

/** @type {Awaited<ReturnType<typeof startFakeProviders>>} */
let fake;
/** @type {Awaited<ReturnType<typeof startDevServer>>} */
let dev;
/** @type {string[]} */
const logs = [];

before(async () => {
  fake = await startFakeProviders();
  const env = await baseEnv({ ...OFFLINE_BASE_URLS, ...fake.env, ...ENV_KEYS });
  const handler = createHandler({ env, logSink: (l) => logs.push(l), errorSink: (l) => logs.push(l) });
  dev = await startDevServer({ port: 0, handler });
});
after(async () => {
  await dev?.close();
  await fake?.close();
});
beforeEach(() => fake.reset());

/** @param {string} model @param {AbortSignal} [signal] */
const stream = (model, signal) =>
  fetch(`${dev.url}/v1/chat/completions`, {
    method: 'POST',
    headers: bearer(),
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    signal,
  });
/** @param {() => boolean} condition */
async function until(condition, ms = 3000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}
/** Usage is written in the background at stream end: poll until the row appears. @param {string} model */
async function usageRow(model) {
  /** @type {any} */
  let row;
  for (let i = 0; i < 100 && !row; i++) {
    const r = await (await fetch(`${dev.url}/control/usage?days=1`, { headers: bearer() })).json();
    row = r.models.find((/** @type {any} */ m) => m.model === model);
    if (!row) await new Promise((res) => setTimeout(res, 20));
  }
  return row;
}

for (const model of ['claude-fake-slow-stream', 'gemini-fake-slow-stream', 'vendor/fake-slow-stream']) {
  test(`${model}: chunks reach the client while the upstream is still sending`, async () => {
    const t0 = Date.now();
    const res = await stream(model);
    assert.equal(res.status, 200);
    const reader = /** @type {ReadableStreamDefaultReader<Uint8Array>} */ (res.body?.getReader());
    const decoder = new TextDecoder();
    let text = '';
    while (!/"content":"[^"]+"/.test(text)) {
      const { done, value } = await reader.read();
      assert.ok(!done, 'stream ended before any content');
      text += decoder.decode(value, { stream: true });
    }
    const firstContentMs = Date.now() - t0;
    assert.equal(fake.requests.at(-1)?.completed, false, 'the fake has not finished sending yet');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    const totalMs = Date.now() - t0;
    assert.match(text, /data: \[DONE\]\n\n$/);
    assert.ok(totalMs - firstContentMs >= 400, `first content after ${firstContentMs} ms, end after ${totalMs} ms`);
    await until(() => fake.requests.at(-1)?.completed === true);
  });
}

test('client disconnect mid-stream aborts the upstream request; usage known so far is recorded, never priced', async () => {
  fake.setDefaults({ scenario: 'slow-stream' }); // a priced model name, served slowly
  const controller = new AbortController();
  const res = await stream('claude-haiku-5-5', controller.signal);
  const reader = /** @type {ReadableStreamDefaultReader<Uint8Array>} */ (res.body?.getReader());
  await reader.read();
  controller.abort();
  await until(() => fake.requests.at(-1)?.aborted === true);
  assert.equal(fake.requests.at(-1)?.completed, false);
  const row = await usageRow('claude-haiku-5-5');
  assert.deepEqual([row.requests, row.errors, row.prompt_tokens, row.cost_unknown, row.cost_estimated], [1, 0, 2500, 1, 0]);
  await until(() => logs.some((l) => l.includes('"error_code":"client_disconnected"')));
});

test('client disconnect before the upstream answers aborts the upstream fetch', async () => {
  await assert.rejects(stream('gemini-early-fake-slow-first-byte', AbortSignal.timeout(150)));
  await until(() => fake.requests.at(-1)?.aborted === true);
  const row = await usageRow('gemini-early-fake-slow-first-byte');
  assert.deepEqual([row.requests, row.errors, row.usage_missing, row.cost_unknown], [1, 0, 1, 1]);
});
