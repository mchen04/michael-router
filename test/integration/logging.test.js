// End-to-end secrecy: run every kind of request — control routes, proxied successes, streaming,
// every error class — with sentinel secrets through real dev-server processes, fake Upstash and
// the fake providers, then assert no sentinel appears in any log line, response, event or the
// store, and that every log line carries allowlisted fields only.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startFakeProviders } from '../../dev/fake-providers.js';
import { EXCEPTION_FIELDS, LOG_FIELDS } from '../../src/log.js';
import { REDACTED } from '../../src/redact.js';
import { ENV_KEYS, PASSWORD, ROUTER_SECRET, STORE_TOKEN, WRONG_PASSWORD, passwordHash } from '../helpers/fixtures.js';
import { startDevServer, startFakeUpstash } from '../helpers/processes.js';

const STORED_KEY = 'sk-ant-fake-SENTINEL-logged-claude-0008';
const KEPT_KEY = 'sk-or-fake-SENTINEL-kept-openrouter-0009';
const PLAIN_PASSWORD = 'plain-SENTINEL-router-password-42';
const PROMPT = 'prompt-SENTINEL-do-not-log-this-text';

/** @type {Awaited<ReturnType<typeof startDevServer>>} */
let dev;
/** @type {Awaited<ReturnType<typeof startDevServer>>} */
let plain;
/** @type {Awaited<ReturnType<typeof startFakeUpstash>>} */
let store;
/** @type {Awaited<ReturnType<typeof startFakeProviders>>} */
let providers;
/** @type {string} */
let hash;

before(async () => {
  hash = await passwordHash();
  [store, providers] = await Promise.all([startFakeUpstash(STORE_TOKEN, ['--debug-dump']), startFakeProviders()]);
  [dev, plain] = await Promise.all([
    startDevServer(
      {
        ROUTER_PASSWORD_HASH: hash,
        ROUTER_SECRET,
        KV_REST_API_URL: store.url,
        KV_REST_API_TOKEN: STORE_TOKEN,
        ...ENV_KEYS,
        ...providers.env,
        AUTH_BACKOFF_BASE_MS: '10',
        AUTH_BACKOFF_MAX_MS: '20',
      },
      ['--upstream-timeout-ms', '400'],
    ),
    startDevServer({ ROUTER_PASSWORD: PLAIN_PASSWORD, ROUTER_SECRET, ROUTER_STORE: 'memory', ...ENV_KEYS, ...providers.env }),
  ]);
});
after(async () => {
  await Promise.all([dev?.stop(), plain?.stop(), store?.stop(), providers?.close()]);
});

/** @param {string} model @param {Record<string, unknown>} [extra] */
const chat = (model, extra = {}) => ({
  method: 'POST',
  body: JSON.stringify({ model, messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: PROMPT }], ...extra }),
});

const SECRETS = () => [
  PASSWORD,
  WRONG_PASSWORD,
  PLAIN_PASSWORD,
  ROUTER_SECRET,
  STORE_TOKEN,
  hash,
  ...hash.split('$').slice(4),
  STORED_KEY,
  KEPT_KEY,
  PROMPT,
  ...Object.values(ENV_KEYS),
];

/**
 * @param {string} url
 * @param {{path: string, init?: RequestInit, auth?: string | null, status: number}[]} steps
 * @param {string} password
 */
async function run(url, steps, password) {
  /** @type {string[]} */
  const texts = [];
  for (const [i, { path, init = {}, auth = password, status }] of steps.entries()) {
    const headers = auth === null ? {} : { authorization: `Bearer ${auth}` };
    const res = await fetch(url + path, { ...init, headers });
    const text = await res.text();
    assert.equal(res.status, status, `step ${i}: ${init.method ?? 'GET'} ${path}`);
    for (const secret of SECRETS()) assert.ok(!text.includes(secret), `response to ${path} leaked a secret`);
    texts.push(text);
    if (auth !== password) await new Promise((r) => setTimeout(r, 50)); // let any backoff wait lapse
  }
  return texts;
}

/** @param {string} stdout @param {string} stderr @param {number} count */
function checkLogs(stdout, stderr, count) {
  const lines = stdout.split('\n').filter(Boolean);
  assert.match(lines[0], /^listening on http:\/\//);
  const requestLines = lines.slice(1).map((l) => JSON.parse(l));
  assert.equal(requestLines.length, count, 'exactly one log line per API request');
  for (const line of requestLines) {
    for (const key of Object.keys(line)) assert.ok(LOG_FIELDS.includes(key), `unexpected log field ${key}`);
    assert.ok(line.request_id && line.method && typeof line.status === 'number' && typeof line.duration_ms === 'number');
  }
  for (const line of stderr.split('\n').filter(Boolean)) {
    for (const key of Object.keys(JSON.parse(line))) assert.ok(EXCEPTION_FIELDS.includes(key), `unexpected stderr field ${key}`);
  }
  return requestLines;
}

test('no secret or prompt reaches logs, events or the store across the whole API surface; log lines are allowlisted', async () => {
  const steps = [
    { path: '/control/health', auth: null, status: 401 },
    { path: '/control/health', auth: WRONG_PASSWORD, status: 401 },
    { path: '/control/health', auth: ROUTER_SECRET, status: 401 },
    { path: '/control/health', status: 200 },
    { path: '/control/keys', status: 200 },
    { path: '/control/keys/claude', init: { method: 'PUT', body: JSON.stringify({ key: STORED_KEY, verify: true }) }, status: 200 },
    { path: '/control/keys/gemini', init: { method: 'PUT', body: JSON.stringify({ key: `bad key ${ENV_KEYS.GEMINI_API_KEY}` }) }, status: 400 },
    { path: '/v1/models', status: 200 },
    { path: '/v1/chat/completions', init: chat('claude-haiku-5-5'), status: 200 },
    { path: '/v1/chat/completions', init: chat('claude-haiku-5-5', { stream: true, stream_options: { include_usage: true } }), status: 200 },
    { path: '/v1/chat/completions', init: chat('gemini-2.5-flash', { stream: true }), status: 200 },
    { path: '/v1/chat/completions', init: chat('openrouter/auto', { stream: true }), status: 200 },
    { path: '/v1/chat/completions', init: chat('google/gemini-2.5-flash-lite'), status: 200 },
    { path: '/v1/chat/completions', init: chat('claude-fake-401'), status: 502 },
    { path: '/v1/chat/completions', init: chat('gemini-fake-invalid-key'), status: 502 },
    { path: '/v1/chat/completions', init: chat('vendor/fake-429'), status: 429 },
    { path: '/v1/chat/completions', init: chat('vendor/fake-200-error'), status: 502 },
    { path: '/v1/chat/completions', init: chat('claude-fake-echo-auth'), status: 400 },
    { path: '/v1/chat/completions', init: chat('gemini-fake-echo-auth', { stream: true }), status: 200 },
    { path: '/v1/chat/completions', init: chat('claude-fake-echo-auth', { stream: true }), status: 200 },
    { path: '/v1/chat/completions', init: chat('vendor/fake-midstream-error-done', { stream: true }), status: 200 },
    { path: '/v1/chat/completions', init: chat('claude-fake-truncated', { stream: true }), status: 200 },
    { path: '/v1/chat/completions', init: chat('gemini-fake-slow-first-byte'), status: 504 },
    { path: '/v1/chat/completions', init: chat('claude-haiku-5-5', { response_format: { type: 'json_object' } }), status: 400 },
    { path: '/v1/chat/completions', init: chat('gpt-5'), status: 400 },
    { path: '/v1/chat/completions', init: { method: 'POST', body: `{"model":"claude-haiku-5-5","messages":"${PROMPT}` }, status: 400 },
    { path: '/control/keys/openrouter', init: { method: 'PUT', body: JSON.stringify({ key: KEPT_KEY }) }, status: 200 },
    { path: '/control/usage?days=7', status: 200 },
    { path: '/control/errors?limit=200', status: 200 },
    { path: '/control/nope', status: 404 },
    { path: '/control/keys', init: { method: 'POST' }, status: 405 },
    { path: '/api/router?__route=control/health', status: 200 },
    { path: '/control/keys/claude', init: { method: 'DELETE' }, status: 200 },
  ];
  const texts = await run(dev.url, steps, PASSWORD);
  const echoed = texts.filter((_, i) => /echo-auth/.test(String(steps[i].init?.body ?? '')));
  assert.equal(echoed.length, 3);
  for (const text of echoed) assert.match(text, /\[redacted\]/, 'the provider echoed our key; the gateway scrubbed it');
  const events = JSON.parse(texts[steps.findIndex((s) => s.path.startsWith('/control/errors'))]);
  const echoEvents = events.filter((/** @type {any} */ e) => /echo-auth/.test(String(e.model)));
  assert.equal(echoEvents.length, 3);
  assert.ok(
    echoEvents.every((/** @type {any} */ e) => e.kind === 'upstream' && e.message && !e.message.includes(REDACTED)),
    'events keep a static message, not the scrubbed upstream text',
  );
  for (const r of providers.requests) assert.ok(!JSON.stringify(r.headers).includes(PASSWORD), 'the router password never reaches a provider');

  assert.equal((await fetch(`${dev.url}/`)).status, 200);
  await new Promise((r) => setTimeout(r, 300)); // background event/usage writes
  const dump = await (await fetch(`${store.url}/__dump`, { headers: { authorization: `Bearer ${STORE_TOKEN}` } })).text();
  await dev.stop();
  const { stdout, stderr } = dev.output();
  for (const [name, text] of [
    ['stdout', stdout],
    ['stderr', stderr],
    ['store dump', dump],
  ]) {
    for (const secret of SECRETS()) assert.ok(!text.includes(secret), `${name} contains a secret`);
    assert.ok(!text.includes('SENTINEL'), `${name} contains a sentinel`);
  }
  assert.match(dump, /mr:v1:keys/, 'the dump does contain the (encrypted) key record');
  assert.match(dump, /mr:v1:events/);
  assert.match(dump, /mr:v1:usage:/);
  const lines = checkLogs(stdout, stderr, steps.length);
  assert.deepEqual(
    lines.map((l) => l.status),
    steps.map((s) => s.status),
  );
  const byModel = (/** @type {string} */ m) => lines.find((l) => l.model === m);
  assert.deepEqual([byModel('claude-fake-truncated')?.error_code, byModel('claude-fake-truncated')?.provider], ['upstream_stream_incomplete', 'claude']);
  assert.equal(byModel('gemini-fake-slow-first-byte')?.error_code, 'upstream_timeout');
  assert.ok(typeof byModel('google/gemini-2.5-flash-lite')?.upstream_ms === 'number');
});

test('error text quoting the prompt or other client text reaches the client, never the store, events or logs', async () => {
  const MARKER = 'marker-SENTINEL-quoted-prompt-0042';
  const echoStore = await startFakeUpstash(STORE_TOKEN, ['--debug-dump']);
  const echo = await startDevServer({
    ROUTER_PASSWORD_HASH: hash,
    ROUTER_SECRET,
    KV_REST_API_URL: echoStore.url,
    KV_REST_API_TOKEN: STORE_TOKEN,
    ...ENV_KEYS,
    ...providers.env,
  });
  try {
    const ask = (/** @type {string} */ model, /** @type {Record<string, unknown>} */ extra = {}) => ({
      method: 'POST',
      body: JSON.stringify({ model, messages: [{ role: 'user', content: `Summarize: ${MARKER}` }], ...extra }),
    });
    const claude = (/** @type {unknown[]} */ messages) => ({ method: 'POST', body: JSON.stringify({ model: 'claude-haiku-5-5', messages }) });
    const steps = [
      // the provider quotes the prompt: an HTTP error, an in-stream error, OpenRouter's 200 error body
      ...['claude-fake-echo-prompt', 'gemini-fake-echo-prompt', 'vendor/fake-echo-prompt'].flatMap((model) => [
        { path: '/v1/chat/completions', init: ask(model), status: 400 },
        { path: '/v1/chat/completions', init: ask(model, { stream: true }), status: 200 },
      ]),
      { path: '/v1/chat/completions', init: ask('vendor/fake-echo-prompt-200'), status: 502 },
      // gateway messages that quote client text: model name, message role, content part type, tool call id
      { path: '/v1/chat/completions', init: ask(MARKER), status: 400 },
      { path: '/v1/chat/completions', init: claude([{ role: MARKER, content: 'hi' }]), status: 400 },
      { path: '/v1/chat/completions', init: claude([{ role: 'user', content: [{ type: MARKER }] }]), status: 400 },
      {
        path: '/v1/chat/completions',
        init: claude([{ role: 'user', content: 'hi' }, { role: 'assistant', content: null, tool_calls: [{ id: MARKER, type: 'function', function: { name: 'f', arguments: '[1]' } }] }]),
        status: 400,
      },
    ];
    const texts = await run(echo.url, steps, PASSWORD);
    for (const [i, text] of texts.entries()) assert.ok(text.includes(MARKER), `step ${i}: the client gets the error text`);
    await new Promise((r) => setTimeout(r, 300)); // background event/usage writes
    const events = await (await fetch(`${echo.url}/control/errors?limit=200`, { headers: { authorization: `Bearer ${PASSWORD}` } })).json();
    assert.equal(events.length, steps.length, 'every error is recorded');
    assert.ok(events.every((/** @type {any} */ e) => typeof e.message === 'string' && e.message !== ''), 'with a static message');
    const dump = await (await fetch(`${echoStore.url}/__dump`, { headers: { authorization: `Bearer ${STORE_TOKEN}` } })).text();
    await echo.stop();
    const { stdout, stderr } = echo.output();
    for (const [name, text] of [
      ['events', JSON.stringify(events)],
      ['store dump', dump],
      ['stdout', stdout],
      ['stderr', stderr],
    ]) {
      assert.ok(!text.includes(MARKER), `${name} contains client text`);
    }
    assert.match(dump, /mr:v1:events/);
    assert.equal(checkLogs(stdout, stderr, steps.length + 1).length, steps.length + 1);
  } finally {
    await Promise.all([echo.stop(), echoStore.stop()]);
  }
});

test('ROUTER_PASSWORD (plaintext) server: the password never appears in logs, responses or errors', async () => {
  const steps = [
    { path: '/control/health', status: 200 },
    { path: '/control/health', auth: WRONG_PASSWORD, status: 401 },
    { path: '/control/health', auth: `${PLAIN_PASSWORD}x`, status: 401 },
    { path: '/v1/chat/completions', init: chat('claude-haiku-5-5'), status: 200 },
    { path: '/v1/chat/completions', init: chat('claude-fake-echo-auth'), status: 400 },
    { path: '/control/errors', status: 200 },
  ];
  await run(plain.url, steps, PLAIN_PASSWORD);
  await new Promise((r) => setTimeout(r, 100));
  await plain.stop();
  const { stdout, stderr } = plain.output();
  for (const text of [stdout, stderr]) {
    for (const secret of SECRETS()) assert.ok(!text.includes(secret));
    assert.ok(!text.includes('SENTINEL'));
  }
  assert.deepEqual(
    checkLogs(stdout, stderr, steps.length).map((l) => l.status),
    steps.map((s) => s.status),
  );
});
