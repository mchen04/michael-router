// POST /v1/chat/completions, GET /v1/models and key verification through the real handler against
// the fake providers (dev/fake-providers.js): forwarding, translation, error table, usage and cost.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { FAKE_TEXT, startFakeProviders } from '../../dev/fake-providers.js';
import { createSSEParser } from '../../src/sse.js';
import { ENV_KEYS, PASSWORD, bearer, fakeClock } from '../helpers/fixtures.js';
import { makeHarness } from '../helpers/harness.js';
import { startRedirectTrap } from '../helpers/redirect-trap.js';

const PROMPT = 'prompt-SENTINEL-proxy-test';
const MESSAGES = [{ role: 'user', content: PROMPT }];
const ALLOWED_UPSTREAM_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'content-type',
  'user-agent',
  'accept',
  'accept-language',
  'accept-encoding',
  'sec-fetch-mode',
  'authorization',
  'x-api-key',
  'anthropic-version',
]);

/** @type {Awaited<ReturnType<typeof startFakeProviders>>} */
let fake;
before(async () => {
  fake = await startFakeProviders();
});
after(() => fake.close());
beforeEach(() => fake.reset());

/** @param {Record<string, string>} [env] @param {Parameters<typeof makeHarness>[0]} [options] */
const harness = (env = {}, options = {}) => makeHarness({ ...options, env: { ...fake.env, ...ENV_KEYS, ...env } });
/** @param {any} h @param {Record<string, unknown>} body @param {Record<string, string>} [headers] */
const chat = async (h, body, headers = {}) => {
  const scenario = /vendor\/fake-([a-z0-9-]+):free$/.exec(String(body.model))?.[1];
  if (scenario) fake.setDefaults({ scenario });
  try {
    return await h.call('/v1/chat/completions', { method: 'POST', headers: { ...bearer(), ...headers }, body: JSON.stringify({ messages: MESSAGES, ...body }) });
  } finally {
    if (scenario) fake.setDefaults({ scenario: 'ok' });
  }
};
/** @param {string} text */
function sse(text) {
  const p = createSSEParser();
  return [...p.push(text), ...p.end()];
}
/** @param {string} text @returns {any[]} JSON data events (not [DONE], not comments) */
const chunksOf = (text) =>
  sse(text)
    .filter((i) => 'data' in i && i.data !== '[DONE]')
    .map((i) => JSON.parse(/** @type {any} */ (i).data));
/** @param {any} h */
async function usageRows(h) {
  await h.settle();
  const r = await h.call('/control/usage?days=1', { headers: bearer() });
  return { ...r.json, byModel: Object.fromEntries(r.json.models.map((/** @type {any} */ m) => [`${m.provider}\t${m.model}`, m])) };
}
/** @param {any} h @param {string} [kind] */
async function events(h, kind = 'upstream') {
  await h.settle();
  return (await h.call(`/control/errors?kind=${kind}`, { headers: bearer() })).json;
}
/** @param {() => boolean} condition */
async function until(condition, ms = 3000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('validation before forwarding: invalid JSON, model rules, 4 MiB limit, provider_not_configured, Claude adapter rejections; nothing reaches a provider', async () => {
  const unconfigured = await makeHarness({ env: fake.env });
  const configured = await harness();
  const post = (/** @type {any} */ h, /** @type {string} */ body) => h.call('/v1/chat/completions', { method: 'POST', headers: bearer(), body });
  const claudeBody = (/** @type {Record<string, unknown>} */ extra) => JSON.stringify({ model: 'claude-haiku-5-5', messages: MESSAGES, ...extra });
  /** @type {[any, string, number, string, string | null][]} harness, body, status, code, x-router-provider */
  const cases = [
    [unconfigured, '{nope', 400, 'invalid_json', null],
    [unconfigured, '[1]', 400, 'invalid_json', null],
    [unconfigured, '{"messages":[]}', 400, 'model_required', null],
    [unconfigured, '{"model":"claude x"}', 400, 'invalid_model', null],
    [unconfigured, '{"model":"other-model"}', 400, 'model_not_routable', null],
    [unconfigured, JSON.stringify({ model: 'claude-haiku-5-5', pad: 'x'.repeat(4 * 1024 * 1024) }), 413, 'payload_too_large', null],
    [unconfigured, '{"model":"claude-haiku-5-5"}', 503, 'provider_not_configured', 'claude'],
    [unconfigured, '{"model":"gemini-2.5-flash"}', 503, 'provider_not_configured', 'gemini'],
    [unconfigured, '{"model":"openrouter/free"}', 503, 'provider_not_configured', 'openrouter'],
    [configured, claudeBody({ response_format: { type: 'json_object' } }), 400, 'unsupported_parameter', 'claude'],
    [configured, claudeBody({ n: 3 }), 400, 'unsupported_parameter', 'claude'],
    [configured, claudeBody({ messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }] }), 400, 'unsupported_content', 'claude'],
  ];
  for (const [h, body, status, code, provider] of cases) {
    const r = await post(h, body);
    assert.equal(r.status, status, code);
    assert.deepEqual([r.json.error.type, r.json.error.code, r.json.error.param], ['gateway_error', code, null]);
    assert.deepEqual([r.headers.get('x-router-error-source'), r.headers.get('x-router-provider')], ['gateway', provider], code);
  }
  assert.match(String((await post(unconfigured, '{"model":"openrouter/free"}')).json.error.message), /OPENROUTER_API_KEY/);
  assert.equal(fake.requests.length, 0);
  const gateway = await events(unconfigured, 'gateway');
  assert.deepEqual(
    gateway.filter((/** @type {any} */ e) => e.code === 'provider_not_configured').map((/** @type {any} */ e) => `${e.provider}:${e.model}`),
    ['openrouter:openrouter/free', 'openrouter:openrouter/free', 'gemini:gemini-2.5-flash', 'claude:claude-haiku-5-5'],
  );
});

test('upstream requests carry only content-type, the provider auth header and user-agent; client headers never reach a provider', async () => {
  const h = await harness();
  const clientHeaders = {
    cookie: 'session=SENTINEL-cookie',
    'x-forwarded-for': '203.0.113.9',
    'x-real-ip': '203.0.113.9',
    'x-stainless-lang': 'js',
    'x-stainless-os': 'MacOS',
    'openai-organization': 'org-SENTINEL',
    'x-router-cache': 'on',
    'http-referer': 'https://client.example',
  };
  for (const model of ['claude-haiku-5-5', 'gemini-2.5-flash', 'openrouter/free']) {
    assert.equal((await chat(h, { model }, clientHeaders)).status, 200, model);
  }
  assert.equal(fake.requests.length, 3);
  const [claude, gemini, openrouter] = fake.requests;
  assert.equal(claude.headers['x-api-key'], ENV_KEYS.ANTHROPIC_API_KEY);
  assert.equal(claude.headers['anthropic-version'], '2023-06-01');
  assert.equal(claude.headers.authorization, undefined);
  assert.equal(gemini.headers.authorization, `Bearer ${ENV_KEYS.GEMINI_API_KEY}`);
  assert.equal(openrouter.headers.authorization, `Bearer ${ENV_KEYS.OPENROUTER_API_KEY}`);
  for (const r of fake.requests) {
    assert.match(String(r.headers['user-agent']), /^michael-router\/\d+\.\d+\.\d+$/);
    assert.equal(r.headers['content-type'], 'application/json');
    for (const name of Object.keys(r.headers)) assert.ok(ALLOWED_UPSTREAM_HEADERS.has(name), `${r.provider} received ${name}`);
    assert.ok(!JSON.stringify(r.headers).includes(PASSWORD), 'the router password is never forwarded');
  }
});

test('the effective key is used: a stored override beats the env key; deleting it falls back to env', async () => {
  const h = await harness();
  const override = 'sk-ant-fake-SENTINEL-override-0001';
  assert.equal((await h.call('/control/keys/claude', { method: 'PUT', headers: bearer(), body: JSON.stringify({ key: override }) })).status, 200);
  await chat(h, { model: 'claude-haiku-5-5' });
  assert.equal(fake.requests.at(-1)?.headers['x-api-key'], override);
  await h.call('/control/keys/claude', { method: 'DELETE', headers: bearer() });
  await chat(h, { model: 'claude-haiku-5-5' });
  assert.equal(fake.requests.at(-1)?.headers['x-api-key'], ENV_KEYS.ANTHROPIC_API_KEY);
});

test('pass-through non-streaming: request bytes forwarded unchanged; upstream body bytes, status and content-type returned unchanged', async () => {
  const h = await harness();
  for (const [model, provider, path] of [
    ['google/gemini-2.5-flash-lite:free', 'openrouter', '/api/v1/chat/completions'],
    ['gemini-2.5-flash-lite', 'gemini', '/v1beta/openai/chat/completions'],
  ]) {
    const raw = `{ "model" : "${model}",\n  "messages": ${JSON.stringify(MESSAGES)}, "seed": 7, "reasoning_effort": "high", "vendor_extra": {"a": [1, 2]} }`;
    const r = await h.call('/v1/chat/completions', { method: 'POST', headers: bearer(), body: raw });
    assert.equal(r.status, 200);
    if (provider === 'gemini') assert.equal(fake.requests.at(-1)?.raw, raw, `${provider}: request bytes unchanged`);
    else assert.equal(fake.requests.at(-1)?.body.provider.max_price.prompt, 0);
    const key = provider === 'gemini' ? ENV_KEYS.GEMINI_API_KEY : ENV_KEYS.OPENROUTER_API_KEY;
    const direct = await fetch(`${fake.url}/${provider}${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: raw });
    assert.equal(r.text, await direct.text(), `${provider}: response bytes unchanged`);
    assert.equal(r.headers.get('content-type'), direct.headers.get('content-type'));
    assert.equal(r.headers.get('x-router-provider'), provider);
  }
  assert.ok((await chat(h, { model: 'google/gemini-2.5-flash-lite:free' })).text.startsWith('\n'), 'OpenRouter leading whitespace kept');
});

test('server-timing: auth, store, upstream and gw on pass-through and Claude routes, streaming or not; gw is measured before the first byte', async () => {
  const h = await harness();
  /** @param {any} r */
  const timings = (r) => {
    const header = String(r.headers.get('server-timing'));
    assert.match(header, /^auth;dur=[\d.]+, store;dur=[\d.]+, upstream;dur=[\d.]+, gw;dur=[\d.]+$/);
    return Object.fromEntries(header.split(', ').map((e) => [e.split(';')[0], Number(e.split('=')[1])]));
  };
  for (const model of ['gemini-2.5-flash-lite', 'claude-haiku-5-5']) {
    for (const stream of [false, true]) {
      const r = await chat(h, { model, stream });
      assert.equal(r.status, 200, `${model} stream=${stream}`);
      const t = timings(r);
      assert.ok(t.gw >= t.upstream, `${model} stream=${stream}: gw includes upstream`);
    }
  }
  const started = performance.now();
  const slow = await chat(h, { model: 'gemini-fake-slow-stream', stream: true });
  assert.ok(performance.now() - started >= 1000, 'the slow stream takes at least 1 s');
  assert.ok(timings(slow).gw < 1000, 'gw stops at the response headers, not at the end of the stream');
});

test('Claude non-streaming: translated response, cache_control by default, x-router-cache: off, dropped sampling params named', async () => {
  const h = await harness();
  const r = await chat(h, { model: 'claude-haiku-5-5', temperature: 0.5, top_p: 0.9, max_tokens: 256 });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-router-dropped-params'), 'temperature, top_p');
  assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(
    { ...r.json, created: 0 },
    {
      id: 'msg_fake_01',
      object: 'chat.completion',
      created: 0,
      model: 'claude-haiku-5-5',
      choices: [{ index: 0, message: { role: 'assistant', content: FAKE_TEXT.claude.join('') }, logprobs: null, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2500, completion_tokens: 50, total_tokens: 2550, prompt_tokens_details: { cached_tokens: 2000, cache_write_tokens: 400 } },
    },
  );
  const sent = fake.requests.at(-1)?.body;
  assert.deepEqual([sent.model, sent.max_tokens, sent.cache_control, 'temperature' in sent], ['claude-haiku-5-5', 256, { type: 'ephemeral' }, false]);
  assert.deepEqual(sent.messages, [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }]);

  const off = await chat(h, { model: 'claude-haiku-4-5', temperature: 0.5 }, { 'x-router-cache': 'off' });
  assert.equal(off.headers.get('x-router-dropped-params'), null, 'sampling:true models keep temperature');
  assert.deepEqual([fake.requests.at(-1)?.body.cache_control, fake.requests.at(-1)?.body.temperature], [undefined, 0.5]);
  const tools = await chat(h, { model: 'claude-fake-ok-tools' });
  assert.deepEqual(tools.json.choices[0].message.tool_calls.map((/** @type {any} */ c) => [c.id, c.function.arguments]), [
    ['toolu_fake_1', '{"city":"Paris"}'],
    ['toolu_fake_2', '{"tz":"CET"}'],
  ]);
  assert.equal(tools.json.choices[0].finish_reason, 'tool_calls');
});

test('§5.4 error table for upstream HTTP errors: status, code, upstream_status, Retry-After, events, never 401', async () => {
  const h = await harness();
  /** @type {[string, number, string, number, RegExp?][]} model, status, code, upstream_status, message */
  const cases = [
    ['claude-fake-401', 502, 'provider_auth_failed', 401],
    ['vendor/fake-invalid-key:free', 502, 'provider_auth_failed', 401],
    ['gemini-fake-invalid-key', 502, 'provider_auth_failed', 400, /rejected the router's API key.*API key not valid/],
    ['gemini-fake-expired-key', 502, 'provider_auth_failed', 400, /rejected the router's API key.*API key expired/],
    ['gemini-fake-400', 400, 'INVALID_ARGUMENT', 400],
    ['claude-fake-400', 400, 'invalid_request_error', 400],
    ['vendor/fake-402:free', 402, 'provider_billing', 402],
    ['claude-fake-403', 403, 'provider_forbidden', 403],
    ['gemini-fake-403', 403, 'provider_forbidden', 403],
    ['gemini-fake-429', 429, 'provider_rate_limited', 429],
    ['claude-fake-429', 429, 'provider_rate_limited', 429],
    ['claude-fake-404', 404, 'not_found_error', 404],
    ['vendor/fake-500:free', 500, 'provider_error', 500],
    ['gemini-fake-503', 503, 'UNAVAILABLE', 503],
    ['claude-fake-529', 529, 'overloaded_error', 529],
    ['vendor/fake-200-error:free', 502, 'provider_error', 200],
  ];
  for (const [model, status, code, upstream, message = /./] of cases) {
    for (const stream of [false, true]) {
      const r = await chat(h, { model, stream });
      assert.equal(r.status, status, `${model} stream=${stream}`);
      const provider = model.includes('/') ? 'openrouter' : model.split('-')[0];
      assert.deepEqual(r.json.error, { ...r.json.error, type: 'upstream_error', code, param: null, provider, upstream_status: upstream });
      assert.match(r.json.error.message, message);
      assert.equal(r.headers.get('x-router-error-source'), 'upstream');
      assert.equal(r.headers.get('x-router-provider'), provider);
      assert.equal(r.headers.get('retry-after'), status === 429 ? '7' : null);
    }
  }
  const recorded = await events(h);
  assert.equal(recorded.length, cases.length * 2);
  assert.deepEqual(recorded.at(-1), { ...recorded.at(-1), kind: 'upstream', code: 'provider_auth_failed', status: 502, provider: 'claude', model: 'claude-fake-401' });
  const rows = await usageRows(h);
  const row = rows.byModel['claude\tclaude-fake-529'];
  assert.deepEqual([row.requests, row.errors, row.cost_unknown, row.usage_missing], [2, 2, 0, undefined], 'errors are counted, not billed');
});

test('unreachable (closed port) -> 502 upstream_unreachable; no response before the timeout -> 504 upstream_timeout, upstream aborted', async () => {
  const closed = await harness({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' });
  const r = await chat(closed, { model: 'claude-haiku-5-5' });
  assert.deepEqual([r.status, r.json.error.type, r.json.error.code, r.json.error.provider], [502, 'upstream_error', 'upstream_unreachable', 'claude']);
  assert.ok(!('upstream_status' in r.json.error));

  const h = await harness({}, { upstreamTimeoutMs: 300 });
  const t = Date.now();
  const slow = await chat(h, { model: 'gemini-fake-slow-first-byte' });
  assert.deepEqual([slow.status, slow.json.error.code, slow.headers.get('x-router-error-source')], [504, 'upstream_timeout', 'upstream']);
  assert.ok(Date.now() - t < 1500, 'answered at the timeout, not when the upstream finally responds');
  await until(() => fake.requests.at(-1)?.aborted === true);
  const rows = await usageRows(h);
  const row = rows.byModel['gemini\tgemini-fake-slow-first-byte'];
  assert.deepEqual([row.errors, row.usage_missing, row.cost_unknown], [1, 1, 1], 'a timed-out request may have been billed: cost unknown');
});

test('a provider redirect is never followed: 502, and neither the key nor the prompt reaches the other origin', async () => {
  const trap = await startRedirectTrap();
  try {
    const h = await harness({ ANTHROPIC_BASE_URL: trap.url, OPENROUTER_BASE_URL: trap.url });
    for (const model of ['claude-haiku-5-5', 'openrouter/free']) {
      const r = await chat(h, { model, stream: true });
      assert.deepEqual([r.status, r.json.error.code], [502, 'upstream_unreachable'], model);
      assert.match(r.json.error.message, /redirect/);
    }
    const verify = await h.call('/control/keys/claude', { method: 'PUT', headers: bearer(), body: JSON.stringify({ key: 'sk-ant-fake-SENTINEL-trap-01', verify: true }) });
    assert.deepEqual([verify.status, verify.json.error.code], [502, 'key_verification_unavailable']);
    assert.deepEqual(trap.received, []);
  } finally {
    await trap.close();
  }
});

test('upstream error messages are scrubbed: a provider echoing our key never leaks it (response, stream); events keep static text', async () => {
  const h = await harness();
  for (const [model, key] of [
    ['claude-fake-echo-auth', ENV_KEYS.ANTHROPIC_API_KEY],
    ['gemini-fake-echo-auth', ENV_KEYS.GEMINI_API_KEY],
    ['vendor/fake-echo-auth:free', ENV_KEYS.OPENROUTER_API_KEY],
  ]) {
    const plain = await chat(h, { model });
    assert.equal(plain.status, 400);
    assert.match(plain.json.error.message, /\[redacted\]/);
    const streamed = await chat(h, { model, stream: true });
    assert.equal(streamed.status, 200);
    const last = chunksOf(streamed.text).at(-1);
    assert.match(last.error.message, /\[redacted\]/);
    for (const text of [plain.text, streamed.text]) assert.ok(!text.includes(key) && !text.includes('SENTINEL'), model);
  }
  const recorded = await events(h);
  assert.equal(recorded.length, 6);
  assert.ok(!JSON.stringify(recorded).includes('SENTINEL') && !JSON.stringify(recorded).includes('[redacted]'));
});

test('streaming Claude: translated chunks, [DONE]; usage chunk only with include_usage', async () => {
  const h = await harness();
  const r = await chat(h, { model: 'claude-haiku-5-5', stream: true });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(r.headers.get('x-router-provider'), 'claude');
  assert.equal(fake.requests.at(-1)?.body.stream, true);
  const items = sse(r.text);
  assert.deepEqual(items.at(-1), { data: '[DONE]' });
  const chunks = chunksOf(r.text);
  assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant', content: '' });
  assert.equal(chunks.map((c) => c.choices[0]?.delta.content ?? '').join(''), FAKE_TEXT.claude.join(''));
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  assert.ok(chunks.every((c) => !c.usage));
  const withUsage = chunksOf((await chat(h, { model: 'claude-haiku-5-5', stream: true, stream_options: { include_usage: true } })).text);
  assert.deepEqual(withUsage.at(-1).choices, []);
  assert.equal(withUsage.at(-1).usage.prompt_tokens, 2500);
});

test('streaming Gemini: include_usage injected upstream; the usage-only chunk is removed unless the client asked; CRLF upstream', async () => {
  const h = await harness();
  const r = await chat(h, { model: 'gemini-2.5-flash-lite', stream: true, stream_options: { foo: 1 } });
  assert.deepEqual(fake.requests.at(-1)?.body.stream_options, { foo: 1, include_usage: true });
  const chunks = chunksOf(r.text);
  assert.ok(chunks.every((c) => c.choices.length > 0), 'no usage-only chunk');
  assert.equal(chunks.map((c) => c.choices[0].delta.content ?? '').join(''), FAKE_TEXT.gemini.join(''));
  assert.deepEqual(sse(r.text).at(-1), { data: '[DONE]' });
  const asked = chunksOf((await chat(h, { model: 'gemini-2.5-flash-lite', stream: true, stream_options: { include_usage: true } })).text);
  assert.deepEqual([asked.at(-1).choices, asked.at(-1).usage.prompt_tokens], [[], 1200]);
  const rows = await usageRows(h);
  const row = rows.byModel['gemini\tgemini-2.5-flash-lite'];
  assert.deepEqual([row.requests, row.prompt_tokens, row.cost_estimated, row.cost_nusd], [2, 2400, 2, 2 * 222000], 'usage recorded even when stripped');
});

test('streaming OpenRouter: comments relayed, the final usage chunk kept, usage.cost -> exact', async () => {
  const h = await harness();
  const r = await chat(h, { model: 'openrouter/free', stream: true });
  const items = sse(r.text);
  assert.deepEqual(items[0], { comment: ' OPENROUTER PROCESSING' });
  assert.deepEqual(items.at(-1), { data: '[DONE]' });
  const last = chunksOf(r.text).at(-1);
  assert.deepEqual([last.choices[0].finish_reason, last.usage.cost], ['stop', 0.00123]);
  assert.equal(fake.requests.at(-1)?.body.stream_options, undefined, 'nothing injected for OpenRouter');
  const row = (await usageRows(h)).byModel['openrouter\topenrouter/free'];
  assert.deepEqual([row.cost_exact, row.cost_nusd, row.reasoning_tokens, row.cached_tokens, row.cost_status], [1, 1230000, 30, 100, 'exact']);
});

test('errors inside a 200 stream: one normalized error chunk, no [DONE] (a trailing upstream [DONE] is swallowed); truncated -> incomplete', async () => {
  const h = await harness();
  /** @type {[string, string][]} */
  const cases = [
    ['claude-fake-midstream-error', 'overloaded_error'],
    ['claude-fake-midstream-error-done', 'overloaded_error'],
    ['gemini-fake-midstream-error', 'INTERNAL'],
    ['gemini-fake-midstream-error-done', 'INTERNAL'],
    ['vendor/fake-midstream-error:free', 'provider_error'],
    ['vendor/fake-midstream-error-done:free', 'provider_error'],
    ['claude-fake-truncated', 'upstream_stream_incomplete'],
    ['gemini-fake-truncated', 'upstream_stream_incomplete'],
    ['vendor/fake-truncated:free', 'upstream_stream_incomplete'],
  ];
  for (const [model, code] of cases) {
    const r = await chat(h, { model, stream: true });
    assert.equal(r.status, 200, model);
    const items = sse(r.text);
    assert.ok(!items.some((i) => 'data' in i && i.data === '[DONE]'), `${model}: no [DONE]`);
    const chunks = chunksOf(r.text);
    const provider = model.includes('/') ? 'openrouter' : model.split('-')[0];
    assert.deepEqual(Object.keys(chunks.at(-1)), ['error'], model);
    assert.deepEqual(chunks.at(-1).error, { ...chunks.at(-1).error, type: 'upstream_error', code, param: null, provider });
    assert.ok(chunks.slice(0, -1).every((c) => !c.error), `${model}: exactly one error chunk`);
    assert.ok(chunks.length >= 2, `${model}: content before the error is relayed`);
  }
  const recorded = await events(h);
  assert.deepEqual(
    recorded.map((/** @type {any} */ e) => e.code).reverse(),
    cases.map(([, code]) => code),
  );
  const row = (await usageRows(h)).byModel['claude\tclaude-fake-truncated'];
  assert.deepEqual([row.errors, row.prompt_tokens, row.cost_unknown], [1, 2500, 1], 'partial usage counted, cost unknown');
});

test('usage and cost aggregates: estimated (cached tokens, cache writes), exact, unknown model, missing usage, expired price', async () => {
  const h = await harness();
  await chat(h, { model: 'claude-haiku-5-5' });
  await chat(h, { model: 'claude-haiku-5-5', stream: true });
  await chat(h, { model: 'google/gemini-2.5-flash-lite:free' });
  await chat(h, { model: 'gemini-2.5-flash-lite' });
  await chat(h, { model: 'claude-sonnet-4-5' }); // routable, not in the price table
  await chat(h, { model: 'claude-fake-no-usage' });
  await chat(h, { model: 'vendor/fake-no-usage:free', stream: true });
  const u = await usageRows(h);
  const haiku = u.byModel['claude\tclaude-haiku-5-5'];
  assert.deepEqual(
    [haiku.requests, haiku.prompt_tokens, haiku.cached_tokens, haiku.cache_write_tokens, haiku.completion_tokens, haiku.cost_nusd, haiku.cost_status],
    [2, 5000, 4000, 800, 100, 2 * 105000, 'estimated'],
  );
  assert.equal(haiku.cost_usd, 0.00021);
  assert.deepEqual([u.byModel['openrouter\tgoogle/gemini-2.5-flash-lite:free'].cost_status, u.byModel['openrouter\tgoogle/gemini-2.5-flash-lite:free'].cost_nusd], ['exact', 1230000]);
  assert.equal(u.byModel['gemini\tgemini-2.5-flash-lite'].cost_nusd, 222000);
  const sonnet = u.byModel['claude\tclaude-sonnet-4-5'];
  assert.deepEqual([sonnet.prompt_tokens, sonnet.cost_nusd, sonnet.cost_unknown, sonnet.cost_status], [2500, 0, 1, 'unknown']);
  for (const id of ['claude\tclaude-fake-no-usage', 'openrouter\tvendor/fake-no-usage:free']) {
    assert.deepEqual([u.byModel[id].usage_missing, u.byModel[id].cost_unknown, u.byModel[id].errors], [1, 1, 0], id);
  }
  assert.equal(u.totals.cost_status, 'partial');
  assert.equal(u.totals.cost_nusd, 2 * 105000 + 1230000 + 222000);

  const later = await harness({}, { clock: fakeClock(Date.parse('2026-12-02T00:00:00Z')) });
  await chat(later, { model: 'gemini-4-argon' });
  const argon = (await usageRows(later)).byModel['gemini\tgemini-4-argon'];
  assert.deepEqual([argon.prompt_tokens, argon.cost_unknown, argon.cost_nusd], [1200, 1, 0], 'past valid_until: tokens counted, never priced');
});

test('Gemini output tokens are max(completion_tokens, total_tokens - prompt_tokens); the hidden part counts as reasoning_tokens', async () => {
  const h = await harness();
  fake.setDefaults({ scenario: 'hidden-thoughts' }); // total_tokens includes 200 thinking tokens completion_tokens leaves out
  await chat(h, { model: 'gemini-2.5-flash' });
  await chat(h, { model: 'gemini-2.5-flash', stream: true });
  fake.setDefaults({ scenario: 'ok' }); // consistent totals: nothing is added
  await chat(h, { model: 'gemini-2.5-flash-lite' });
  const u = await usageRows(h);
  const flash = u.byModel['gemini\tgemini-2.5-flash'];
  assert.deepEqual(
    [flash.requests, flash.prompt_tokens, flash.cached_tokens, flash.completion_tokens, flash.reasoning_tokens, flash.cost_status],
    [2, 2400, 400, 1000, 400, 'estimated'],
  );
  // per request (USD per 1M tokens): 1000 uncached x 0.3 + 200 cached x 0.03 + 500 output x 2.5
  assert.equal(flash.cost_nusd, 2 * (300000 + 6000 + 1250000));
  const lite = u.byModel['gemini\tgemini-2.5-flash-lite'];
  assert.deepEqual([lite.completion_tokens, lite.reasoning_tokens], [300, 0]);
});

test('a stream the client stops reading is finished on client abort or upstream timeout: usage and log written once, waitUntil resolves', async () => {
  for (const [label, upstreamTimeoutMs, abort, errors] of /** @type {const} */ ([
    ['client abort', undefined, true, 0],
    ['upstream timeout', 400, false, 1],
  ])) {
    fake.setDefaults({ scenario: 'slow-stream' });
    const h = await harness({}, { upstreamTimeoutMs });
    const controller = new AbortController();
    /** @type {Promise<unknown>[]} */
    const pending = [];
    const body = JSON.stringify({ model: 'claude-haiku-5-5', stream: true, messages: MESSAGES });
    const res = await h.handler(new Request('http://localhost/v1/chat/completions', { method: 'POST', headers: bearer(), body, signal: controller.signal }), {
      remoteAddress: '127.0.0.1',
      waitUntil: (p) => pending.push(p),
    });
    const reader = /** @type {ReadableStreamDefaultReader<Uint8Array>} */ (res.body?.getReader());
    await reader.read(); // then never read or cancel again, as a runtime that drops the body might
    if (abort) controller.abort();
    const settled = (async () => {
      while (pending.length) await Promise.all(pending.splice(0));
      return true;
    })();
    assert.equal(await Promise.race([settled, new Promise((r) => setTimeout(() => r(false), 3000))]), true, `${label}: waitUntil resolved`);
    await until(() => fake.requests.at(-1)?.aborted === true);
    const lines = h.logs.map((l) => JSON.parse(l));
    assert.equal(lines.length, 1, `${label}: one log line`);
    assert.equal(lines[0].error_code, abort ? 'client_disconnected' : 'upstream_timeout');
    if (!abort) {
      const rest = [];
      for (let r = await reader.read(); !r.done; r = await reader.read()) rest.push(new TextDecoder().decode(r.value));
      assert.equal(chunksOf(rest.join('')).at(-1).error.code, 'upstream_timeout', 'a later read still gets the error chunk');
    }
    const row = (await usageRows(h)).byModel['claude\tclaude-haiku-5-5'];
    assert.deepEqual([row.requests, row.errors, row.prompt_tokens, row.cost_unknown], [1, errors, 2500, 1], `${label}: usage recorded once`);
    assert.equal(h.logs.filter((l) => JSON.parse(l).model === 'claude-haiku-5-5').length, 1, `${label}: still one log line for the stream`);
  }
});

test('GET /v1/models: only configured providers, OpenAI list shape, context_length when known', async () => {
  const one = await makeHarness({ env: { GEMINI_API_KEY: ENV_KEYS.GEMINI_API_KEY } });
  const r = await one.call('/v1/models', { headers: bearer() });
  assert.equal(r.status, 200);
  assert.equal(r.json.object, 'list');
  assert.deepEqual([...new Set(r.json.data.map((/** @type {any} */ m) => m.owned_by))], ['gemini']);
  assert.equal(r.json.data.find((/** @type {any} */ m) => m.id === 'gemini-2.5-flash').context_length, 1048576);
  const all = await (await harness()).call('/v1/models', { headers: bearer() });
  assert.deepEqual([...new Set(all.json.data.map((/** @type {any} */ m) => m.owned_by))], ['claude', 'gemini', 'openrouter']);
  assert.deepEqual(all.json.data.find((/** @type {any} */ m) => m.id === 'claude-haiku-5-5'), {
    id: 'claude-haiku-5-5',
    object: 'model',
    created: 0,
    owned_by: 'claude',
    context_length: 1000000,
    max_output_tokens: 128000,
  });
  assert.equal((await (await makeHarness()).call('/v1/models', { headers: bearer() })).json.data.length, 0);
  assert.equal(fake.requests.length, 0, 'served from the price table, no upstream call');
});

test('PUT /control/keys/:p verify:true verifies before storing: a rejected or unverifiable key never replaces a working one', async () => {
  const h = await makeHarness({ env: fake.env });
  const put = (/** @type {string} */ provider, /** @type {string} */ key, verify = true) =>
    h.call(`/control/keys/${provider}`, { method: 'PUT', headers: bearer(), body: JSON.stringify({ key, verify }) });
  const stored = () => Object.fromEntries(h.store.dump().provider_keys.map((/** @type {any} */ k) => [k.provider, k.record]));
  const ok = await put('claude', 'sk-ant-fake-SENTINEL-verify-ok');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { provider: 'claude', configured: true, source: 'store', updated_at: ok.json.updated_at, verified: true, upstream_status: 200 });
  const working = stored().claude;

  for (const [provider, key, upstream] of /** @type {const} */ ([
    ['claude', 'sk-ant-fake-SENTINEL-revoked', 401],
    ['gemini', 'AIzaFAKE-SENTINEL-revoked-01', 400],
    ['openrouter', 'sk-or-fake-SENTINEL-revoked', 401],
  ])) {
    const r = await put(provider, key);
    assert.equal(r.status, 400, provider);
    assert.deepEqual(r.json.error, { ...r.json.error, type: 'upstream_error', code: 'key_rejected', param: null, provider, upstream_status: upstream });
    assert.match(r.json.error.message, /rejected the key.*not stored/);
    assert.equal(r.headers.get('x-router-error-source'), 'upstream');
    assert.ok(!r.text.includes(key));
  }
  fake.setDefaults({ scenario: '503' });
  const down = await put('claude', 'sk-ant-fake-SENTINEL-verify-new');
  assert.deepEqual([down.status, down.json.error.code, down.json.error.upstream_status], [502, 'key_verification_unavailable', 503]);
  assert.match(down.json.error.message, /could not be verified.*not stored/);
  assert.deepEqual(stored(), { claude: working }, 'the working key is untouched; nothing else was stored');

  const unverified = await put('claude', 'sk-ant-fake-SENTINEL-verify-new', false);
  assert.deepEqual([unverified.status, 'verified' in unverified.json], [200, false], 'verify:false stores without asking the provider');
  assert.notEqual(stored().claude, working);
  fake.setDefaults({ scenario: 'ok' });
  for (const [provider, key] of [
    ['gemini', 'AIzaFAKE-SENTINEL-verify-ok-1'],
    ['openrouter', 'sk-or-fake-SENTINEL-verify-ok'],
  ]) {
    const r = await put(provider, key);
    assert.deepEqual([r.status, r.json.verified, r.json.upstream_status], [200, true, 200], provider);
  }
  assert.deepEqual(Object.keys(stored()).sort(), ['claude', 'gemini', 'openrouter']);
  assert.deepEqual(
    fake.requests.map((r) => `${r.method} ${r.provider}${r.path} ${r.headers['x-api-key'] ?? r.headers.authorization}`),
    [
      'GET claude/v1/models sk-ant-fake-SENTINEL-verify-ok',
      'GET claude/v1/models sk-ant-fake-SENTINEL-revoked',
      'GET gemini/v1beta/openai/models Bearer AIzaFAKE-SENTINEL-revoked-01',
      'GET openrouter/api/v1/key Bearer sk-or-fake-SENTINEL-revoked',
      'GET claude/v1/models sk-ant-fake-SENTINEL-verify-new',
      'GET gemini/v1beta/openai/models Bearer AIzaFAKE-SENTINEL-verify-ok-1',
      'GET openrouter/api/v1/key Bearer sk-or-fake-SENTINEL-verify-ok',
    ],
  );
  assert.ok(fake.requests.filter((r) => r.provider === 'claude').every((r) => r.headers['anthropic-version'] === '2023-06-01'));
  const recorded = await events(h);
  assert.deepEqual(
    recorded.map((/** @type {any} */ e) => `${e.code} ${e.provider}`),
    ['key_verification_unavailable claude', 'key_rejected openrouter', 'key_rejected gemini', 'key_rejected claude'],
  );
  assert.ok(!JSON.stringify(recorded).includes('SENTINEL'));
});
