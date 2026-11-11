import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bearer, fakeClock } from '../helpers/fixtures.js';
import { makeHarness } from '../helpers/harness.js';
import { createMemoryStore } from '../../src/store/memory.js';

const STEPS = [
  ['claude', 'claude-opus-5-5', 'ANTHROPIC_API_KEY'],
  ['openai', 'gpt-6.1-sol', 'OPENAI_API_KEY'],
  ['morph', 'deepseek-v4.1-flash', 'MORPH_API_KEY'],
];
const KEYS = Object.fromEntries(STEPS.map(([p, , key]) => [key, `fake-SENTINEL-${p}-key-12345`]));
const encoder = new TextEncoder();
const completion = (provider, extra = {}) => provider === 'claude'
  ? { id: 'msg_fake', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'answer' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 }, ...extra }
  : { id: 'chat_fake', model: 'upstream-alias', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 }, ...extra };
const ok = (provider, extra) => Response.json(completion(provider, extra));
const error = (status, code = 'provider_error', message = 'temporarily unavailable', headers = {}, type) => Response.json({ error: { code, type, message } }, { status, headers });
const sse = (events) => new Response(events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const chunk = (delta = { content: 'answer' }, finish = null) => ({ model: 'upstream-alias', choices: [{ index: 0, delta, finish_reason: finish }] });
const post = (h, extra = {}) => h.call('/v1/chat/completions', { method: 'POST', headers: bearer(), body: JSON.stringify({ model: 'automatic', messages: [{ role: 'user', content: 'hello' }], ...extra }) });

async function setup(t, respond, options = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body));
    const provider = body.model?.startsWith('claude-') ? 'claude' : body.model?.startsWith('gpt-') ? 'openai' : 'morph';
    const call = { provider, model: body.model, body, url: String(url), headers: init.headers, signal: init.signal };
    calls.push(call);
    return respond(call, calls.length);
  });
  const h = await makeHarness({ ...options, env: { ...KEYS, ...options.env } });
  return { h, calls };
}

const FALLBACKS = [
  ['429 with invalid request type', () => error(429, 'rate_limit', 'Busy', {}, 'invalid_request_error'), 'rate_limited'],
  ['402 with auth wording', () => error(402, 'billing_error', 'Payment required; unauthorized', {}, 'authentication_error'), 'quota_exhausted'],
  ...[500, 502, 503, 504, 529].map((status) => [String(status), () => error(status, 'invalid_request_error', status === 503 ? 'Deployment not found' : 'Unsupported, permission forbidden, not_allowed, bad_request'), 'unavailable']),
  ['overloaded error', () => Response.json({ error: { code: 'overloaded_error', type: 'invalid_request_error', message: 'Busy' } }), 'unavailable'],
  ['network failure', () => { throw new TypeError('fetch failed'); }, 'unavailable'],
];

for (const [name, response, reason] of FALLBACKS) {
  test(`availability ${name} falls back once and records the answering model`, async (t) => {
    const { h, calls } = await setup(t, (call) => call.provider === 'claude' ? response(call) : ok(call.provider));
    const r = await post(h);
    assert.equal(r.status, 200);
    assert.equal(r.json.model, 'gpt-6.1-sol');
    assert.equal(r.headers.get('x-router-model'), 'gpt-6.1-sol');
    assert.equal(r.headers.get('x-router-provider'), 'openai');
    assert.equal(r.headers.get('x-router-fallback'), `claude:${reason}`);
    assert.deepEqual(calls.map((call) => call.model), ['claude-opus-5-5', 'gpt-6.1-sol']);
    await h.settle();
    const usage = (await h.call('/control/usage?days=1', { headers: bearer() })).json.models;
    assert.equal(usage.find((row) => row.model === 'claude-opus-5-5').errors, 1);
    assert.equal(usage.find((row) => row.model === 'gpt-6.1-sol').requests, 1);
  });
}

const STOPS = [
  ...[400, 404, 413, 422, 409].map((status) => [String(status), () => error(status, 'invalid_request_error', 'Invalid request'), status]),
  ['authentication', () => error(401, 'authentication_error', 'Bad API key'), 502],
  ['permission', () => error(403, 'permission_error', 'Forbidden'), 403],
  ['context length', () => error(503, 'context_length_exceeded', 'Maximum context exceeded'), 503],
  ...[400, 429, 503].map((status) => [`content policy on ${status}`, () => error(status, 'content_policy_violation', 'Request rejected', {}, 'invalid_request_error'), status]),
  ['hidden safety signal', () => error(529, 'server_error', 'Request rejected', {}, 'safety_refusal'), 529],
];

for (const [name, response, status] of STOPS) {
  test(`${name} stops automatic without another upstream call`, async (t) => {
    const { h, calls } = await setup(t, response);
    const r = await post(h);
    assert.equal(r.status, status);
    assert.equal(calls.length, 1);
    assert.equal(r.headers.get('x-router-provider'), 'claude');
    assert.equal(r.headers.get('x-router-fallback'), '');
    await h.settle();
  });
}

test('a successful premium answer stops automatic immediately', async (t) => {
  const { h, calls } = await setup(t, (call) => ok(call.provider));
  const r = await post(h);
  assert.equal(r.json.model, 'claude-opus-5-5');
  assert.equal(r.headers.get('x-router-model'), 'claude-opus-5-5');
  assert.equal(r.headers.get('x-router-fallback'), '');
  assert.equal(calls.length, 1);
  await h.settle();
});

for (const [name, env, respond, extra, expected] of [
  ['Claude refusal', {}, () => ok('claude', { stop_reason: 'refusal' }), {}, '"finish_reason":"content_filter"'],
  ['streamed content filter', { ANTHROPIC_API_KEY: '' }, () => sse([chunk({}, 'content_filter'), '[DONE]']), { stream: true }, 'content_filter'],
]) {
  test(`${name} is returned without fallback`, async (t) => {
    const { h, calls } = await setup(t, respond, { env });
    const r = await post(h, extra);
    assert.equal(r.status, 200);
    assert.ok(r.text.includes(expected));
    assert.equal(calls.length, 1);
    await h.settle();
  });
}

for (const [name, status, respond, retryAfter] of [
  ['rate limits', 429, (call) => error(429, 'rate_limit', 'Busy', { 'retry-after': call.provider === 'claude' ? '80' : call.provider === 'openai' ? '11' : '40' }), '11'],
  ['mixed outage with HTTP date', 503, (call) => error(call.provider === 'claude' ? 503 : 429, 'provider_error', 'Busy', { 'retry-after': 'Wed, 21 Oct 2026 12:00:19 GMT' }), '19'],
  ['exhausted quota on HTTP 429', 503, () => error(429, 'insufficient_quota', 'Quota exhausted'), '30'],
]) {
  test(`all unavailable ${name} returns the correct status and soonest Retry-After`, async (t) => {
    const { h, calls } = await setup(t, respond, { clock: fakeClock() });
    const r = await post(h);
    assert.equal(r.status, status);
    assert.equal(r.json.error.code, 'all_providers_unavailable');
    assert.match(r.json.error.message, /deepseek-v4.1-flash \(included:/);
    assert.doesNotMatch(r.text, /morph/i);
    assert.equal(r.headers.get('retry-after'), retryAfter);
    for (const [, model] of STEPS) assert.ok(r.json.error.message.includes(model));
    assert.deepEqual(calls.map((call) => call.model), ['claude-opus-5-5', 'gpt-6.1-sol', 'morph-dsv41flash']);
    const repeated = await post(h);
    assert.equal(repeated.status, status);
    assert.equal(repeated.headers.get('retry-after'), retryAfter);
    assert.equal(repeated.headers.get('x-router-fallback'), 'claude:cooldown,openai:cooldown,morph:cooldown');
    assert.equal(calls.length, 3);
    await h.settle();
  });
}

test('cooldowns share state across handlers, bypass explicit requests and recover at expiry', async (t) => {
  const clock = fakeClock();
  const store = createMemoryStore();
  let healthy = false;
  const { h, calls } = await setup(t, (call) => call.provider === 'claude' && !healthy ? error(503) : ok(call.provider), { clock, store });
  assert.equal((await post(h)).json.model, 'gpt-6.1-sol');
  healthy = true;
  const other = await makeHarness({ clock, store, env: KEYS });
  assert.equal((await post(other)).headers.get('x-router-fallback'), 'claude:cooldown');
  assert.equal((await post(h, { model: 'claude-opus-5-5' })).json.model, 'claude-opus-5-5');
  clock.advance(30_000);
  assert.equal((await post(other)).json.model, 'claude-opus-5-5');
  assert.deepEqual(calls.map((call) => call.provider), ['claude', 'openai', 'openai', 'claude', 'claude']);
  await h.settle();
  await other.settle();
});

test('cooldown read and write failures cannot fail a healthy fallback answer', async (t) => {
  const store = createMemoryStore();
  store.getCooldown = async () => { throw new Error('store down'); };
  store.setCooldown = async () => { throw new Error('store down'); };
  const { h, calls } = await setup(t, (call) => call.provider === 'claude' ? error(503) : ok(call.provider), { store });
  assert.equal((await post(h)).json.model, 'gpt-6.1-sol');
  assert.deepEqual(calls.map((call) => call.provider), ['claude', 'openai']);
  await h.settle();
});

test('Retry-After honors valid delays in full and safely bounds extreme values', async (t) => {
  const now = Date.parse('2026-11-10T16:00:00Z');
  for (const [header, untilMs, status] of [
    ['7200', now + 7_200_000, 429],
    ['Tue, 10 Nov 2026 19:00:00 GMT', now + 10_800_000, 503],
    ['0', now + 1000, 429],
    ['Tue, 10 Nov 2026 15:00:00 GMT', now + 1000, 503],
    ['999999999999999999999999999999', 8_640_000_000_000_000, 429],
    ['9999999999', now + 9_999_999_999_000, 503],
    ['invalid', now + 30_000, 429],
    [undefined, now + 30_000, 503],
  ]) {
    const clock = fakeClock(now);
    const { h, calls } = await setup(t, () => error(status, 'provider_error', 'Busy', header === undefined ? {} : { 'retry-after': header }), { clock });
    const r = await post(h);
    assert.equal(r.status, status);
    assert.equal(r.headers.get('retry-after'), String(Math.ceil((untilMs - now) / 1000)), String(header));
    assert.match(r.headers.get('retry-after'), /^[1-9]\d*$/);
    if (untilMs - now > 3_600_000) clock.advance(3_600_000);
    const repeated = await post(h);
    assert.equal(repeated.headers.get('retry-after'), String(Math.ceil((untilMs - clock.now()) / 1000)));
    assert.equal(repeated.headers.get('x-router-fallback'), 'claude:cooldown,openai:cooldown,morph:cooldown');
    assert.equal(calls.length, 3);
    await h.settle();
  }
});

test('missing keys make no upstream call and do not shorten known cooldowns', async (t) => {
  const { h, calls } = await setup(t, () => error(503, 'provider_error', 'Busy', { 'retry-after': '120' }), { env: { MORPH_API_KEY: '' }, clock: fakeClock() });
  const r = await post(h);
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('retry-after'), '120');
  assert.equal(r.headers.get('x-router-fallback'), 'claude:unavailable,openai:unavailable,morph:not_configured');
  assert.equal(calls.length, 2);
  const empty = await makeHarness();
  const unavailable = await post(empty);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get('retry-after'), '30');
  assert.equal(unavailable.headers.get('x-router-fallback'), 'claude:not_configured,openai:not_configured,morph:not_configured');
  assert.equal(calls.length, 2);
  await h.settle();
  await empty.settle();
});

test('automatic finishes the second billing-key retry before selecting another provider', async (t) => {
  const { h, calls } = await setup(t, (call) => call.provider === 'claude' ? error(401, 'billing_error', 'Account credit exhausted') : ok(call.provider), { env: { ANTHROPIC_API_KEY_2: 'fake-SENTINEL-secondary-12345' } });
  assert.equal((await post(h)).json.model, 'gpt-6.1-sol');
  assert.deepEqual(calls.map((call) => call.provider), ['claude', 'claude', 'openai']);
  assert.notEqual(calls[0].headers['x-api-key'], calls[1].headers['x-api-key']);
  await h.settle();
});

for (const [model, upstream] of [['kimi-k3.1-pro', 'morph-kimik31'], ['deepseek-v4.1-flash', 'morph-dsv41flash'], ['morph-kimik31', 'morph-kimik31'], ['morph-dsv41flash', 'morph-dsv41flash']]) {
  test(`explicit ${model} preserves tools and records zero marginal cost`, async (t) => {
    const { h, calls } = await setup(t, (call) => ok(call.provider));
    const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
    const r = await post(h, { model, tools });
    assert.equal(r.json.model, model);
    assert.equal(r.headers.get('x-router-model'), model);
    assert.equal(r.headers.get('x-router-provider'), 'morph');
    assert.equal(r.headers.get('x-router-fallback'), null);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, upstream);
    assert.deepEqual(calls[0].body.tools, tools);
    assert.match(calls[0].url, /\/v1\/chat\/completions$/);
    assert.equal(calls[0].headers.authorization, `Bearer ${KEYS.MORPH_API_KEY}`);
    await h.settle();
    const usage = (await h.call('/control/usage?days=1', { headers: bearer() })).json.models.find((row) => row.model === model);
    assert.equal(usage.requests, 1);
    assert.equal(usage.cost_usd, 0);
    assert.equal(usage.cost_status, 'estimated');
  });
}

test('explicit models never fall back and Morph variants are refused before any upstream call', async (t) => {
  const { h, calls } = await setup(t, () => error(429));
  for (const model of ['morph-dsv41flash', 'morph-kimik31', 'claude-opus-5-5', 'gpt-6.1-sol']) assert.equal((await post(h, { model })).status, 429);
  assert.equal(calls.length, 4);
  for (const model of ['morph-paid', 'morph-dsv41flash-1017', 'morph-paid/vendor:free']) {
    const r = await post(h, { model });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'model_not_allowed');
    assert.match(r.json.error.message, /kimi-k3.1-pro.*deepseek-v4.1-flash/);
    assert.doesNotMatch(r.text, /morph/i);
  }
  assert.equal(calls.length, 4);
  await h.settle();
});

test('models exposes both 1,000,000-token Morph contexts and automatic order', async (t) => {
  const { h } = await setup(t, () => { throw new Error('Catalogue must not call upstream'); });
  const r = await h.call('/v1/models', { headers: bearer() });
  for (const model of ['kimi-k3.1-pro', 'deepseek-v4.1-flash']) {
    const entry = r.json.data.find((entry) => entry.id === model);
    assert.equal(entry.context_length, 1_000_000);
    assert.equal(entry.owned_by, 'included');
  }
  assert.doesNotMatch(r.text, /morph/i);
  assert.match(r.json.data.find((entry) => entry.id === 'automatic').description, /claude-opus-5-5 then gpt-6.1-sol then deepseek-v4.1-flash/);
});

test('a pre-commit stream failure selects the next provider and reports its model in chunks and headers', async (t) => {
  const { h, calls } = await setup(t, (call) => call.provider === 'claude'
    ? new Response(new ReadableStream({ start(controller) { controller.error(new Error('broken before output')); } }), { headers: { 'content-type': 'text/event-stream' } })
    : sse([chunk(), chunk({}, 'stop'), '[DONE]']));
  const r = await post(h, { stream: true });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-router-provider'), 'openai');
  assert.equal(r.headers.get('x-router-model'), 'gpt-6.1-sol');
  assert.equal(r.headers.get('x-router-fallback'), 'claude:unavailable');
  const chunks = r.text.split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)));
  assert.ok(chunks.length > 0);
  assert.ok(chunks.every((item) => item.model === 'gpt-6.1-sol'));
  assert.ok(r.text.includes('[DONE]'));
  assert.deepEqual(calls.map((call) => call.provider), ['claude', 'openai']);
  await h.settle();
});

for (const tools of [false, true]) {
  test(`committed ${tools ? 'tool call' : 'content'} failure terminates without replaying any step`, async (t) => {
    const delta = tools ? { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] } : { content: 'first' };
    const { h, calls } = await setup(t, (call) => {
      if (call.provider === 'claude') return error(503);
      let reads = 0;
      return new Response(new ReadableStream({ pull(controller) {
        if (reads++ === 0) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk(delta))}\n\n`));
        else controller.error(new Error('broken after output'));
      } }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
    });
    const r = await post(h, { stream: true });
    assert.ok(r.text.includes(tools ? 'tool_calls' : 'first'));
    assert.ok(r.text.includes('upstream_stream_incomplete'));
    assert.ok(!r.text.includes('[DONE]'));
    assert.equal(r.headers.get('x-router-model'), 'gpt-6.1-sol');
    assert.deepEqual(calls.map((call) => call.provider), ['claude', 'openai']);
    await h.settle();
  });
}

test('tools and tool results fall back before commitment with payload preserved', async (t) => {
  const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
  const messages = [{ role: 'user', content: 'look up' }, { role: 'assistant', content: null, tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call_0', content: 'result' }];
  const { h, calls } = await setup(t, (call) => call.provider === 'claude' ? error(503) : sse([chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }), chunk({}, 'tool_calls'), '[DONE]']));
  const r = await post(h, { tools, messages, stream: true });
  assert.equal(r.headers.get('x-router-provider'), 'openai');
  assert.ok(r.text.includes('tool_calls'));
  assert.deepEqual(calls[1].body.tools, tools);
  assert.deepEqual(calls[1].body.messages, messages);
  assert.deepEqual(calls.map((call) => call.provider), ['claude', 'openai']);
  await h.settle();
});

test('Claude output followed by an error in the same frame cannot restart on another provider', async (t) => {
  const { h, calls } = await setup(t, () => sse([
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first' } },
    { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
  ]));
  const r = await post(h, { stream: true });
  assert.ok(r.text.includes('first'));
  assert.ok(r.text.includes('overloaded_error'));
  assert.ok(!r.text.includes('[DONE]'));
  assert.equal(calls.length, 1);
  await h.settle();
});

test('a client disconnect before any response never starts another provider', async (t) => {
  const abort = new AbortController();
  const { h, calls } = await setup(t, () => { abort.abort(); throw new TypeError('client left'); });
  const r = await h.call('/v1/chat/completions', { method: 'POST', headers: bearer(), signal: abort.signal, body: JSON.stringify({ model: 'automatic', messages: [{ role: 'user', content: 'hello' }] }) });
  assert.equal(r.status, 499);
  assert.equal(calls.length, 1);
  await h.settle();
});

test('automatic reaches Morph in order and streams its concrete model', async (t) => {
  const { h, calls } = await setup(t, (call) => call.provider === 'morph' ? sse([chunk(), '[DONE]']) : error(503));
  const r = await post(h, { stream: true });
  assert.equal(r.headers.get('x-router-model'), 'deepseek-v4.1-flash');
  assert.equal(r.headers.get('x-router-provider'), 'morph');
  assert.equal(r.headers.get('x-router-fallback'), 'claude:unavailable,openai:unavailable');
  assert.ok(r.text.includes('"model":"deepseek-v4.1-flash"'));
  assert.deepEqual(calls.map((call) => call.model), ['claude-opus-5-5', 'gpt-6.1-sol', 'morph-dsv41flash']);
  await h.settle();
});

test('Morph uses its optional second key only after a definitive billing rejection', async (t) => {
  const { h, calls } = await setup(t, (call, n) => n === 1 ? error(402, 'billing_error', 'No credits') : ok(call.provider), { env: { MORPH_API_KEY_2: 'fake-SENTINEL-morph-secondary-12345' } });
  const r = await post(h, { model: 'morph-dsv41flash' });
  assert.equal(r.status, 200);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].headers.authorization, calls[1].headers.authorization);
  assert.equal(r.headers.get('x-router-fallback'), null);
  await h.settle();
});

test('typed pre-commit stream errors classify availability while request and auth errors stay terminal', async (t) => {
  let current;
  const clock = fakeClock();
  const { h, calls } = await setup(t, (call) => call.provider === 'claude'
    ? sse([{ type: 'error', error: { code: current[2], type: current[0], message: 'Provider error' } }])
    : sse([chunk(), '[DONE]']), { clock });
  for (const entry of [
    ['rate_limit_error', 'rate_limited'], ['rate_limit_exceeded', 'rate_limited'],
    ['billing_error', 'quota_exhausted'], ['insufficient_quota', 'quota_exhausted'],
    ['api_error', 'unavailable'], ['overloaded_error', 'unavailable'],
    ['timeout_error', 'unavailable'], ['server_error', 'unavailable'],
    ['authentication_error', null, 'server_error'], ['permission_error', null],
    ['invalid_request_error', null], ['not_found_error', null],
  ]) {
    current = entry;
    calls.length = 0;
    const r = await post(h, { stream: true });
    assert.equal(r.headers.get('x-router-provider'), entry[1] ? 'openai' : 'claude', entry[0]);
    assert.equal(r.headers.get('x-router-fallback'), entry[1] ? `claude:${entry[1]}` : '', entry[0]);
    assert.deepEqual(calls.map((call) => call.provider), entry[1] ? ['claude', 'openai'] : ['claude'], entry[0]);
    clock.advance(31_000);
  }
  await h.settle();
});

test('automatic shares one invocation budget and skips steps with less than one second left', async (t) => {
  let mode = 'timeout';
  const { h, calls } = await setup(t, (call) => {
    if (mode === 'timeout' || call.provider === 'openai') return new Promise((_, reject) => call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true }));
    return new Promise((resolve) => setTimeout(() => resolve(error(503)), mode === 'short' ? 284_500 : 270_000));
  }, { verifyPassword: async () => true, clock: { now: () => Date.now() } });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  for (mode of ['timeout', 'short', 'remaining']) {
    calls.length = 0;
    const started = Date.now();
    let returnedAt;
    const pending = post(h).then((r) => { returnedAt = Date.now() - started; return r; });
    await flush();
    if (mode === 'remaining') {
      t.mock.timers.tick(270_000);
      await flush();
      assert.deepEqual(calls.map((call) => call.provider), ['claude', 'openai']);
      t.mock.timers.tick(14_999);
      await flush();
      assert.equal(returnedAt, undefined);
      t.mock.timers.tick(1);
    } else t.mock.timers.tick(mode === 'short' ? 284_500 : 285_000);
    await flush();
    const r = await pending;
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, 'all_providers_unavailable');
    assert.match(r.json.error.message, /deepseek-v4.1-flash \(included:/);
    assert.doesNotMatch(r.text, /morph/i);
    assert.ok(returnedAt <= 285_000);
    assert.deepEqual(calls.map((call) => call.provider), mode === 'remaining' ? ['claude', 'openai'] : ['claude']);
    assert.match(r.headers.get('x-router-fallback'), /deadline_exhausted/);
    await h.settle();
    t.mock.timers.tick(31_000);
  }
});

test('multiline JSON stream events carry the concrete model for explicit Morph and automatic', async (t) => {
  const event = JSON.stringify(chunk(), null, 2).split('\n').map((line) => `data: ${line}`).join('\n');
  const { h, calls } = await setup(t, () => new Response(`${event}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }), { env: { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } });
  for (const model of ['kimi-k3.1-pro', 'deepseek-v4.1-flash', 'morph-kimik31', 'morph-dsv41flash', 'automatic']) {
    const r = await post(h, { model, stream: true });
    const data = r.text.split('\n\n')[0].split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(6)).join('\n');
    const expected = model === 'automatic' ? 'deepseek-v4.1-flash' : model;
    assert.equal(JSON.parse(data).model, expected);
    assert.equal(r.headers.get('x-router-model'), expected);
    assert.ok(r.text.includes('[DONE]'));
  }
  assert.equal(calls.length, 5);
  await h.settle();
});

test('token-per-minute wording is a rate limit rather than a context-length error', async (t) => {
  const { h, calls } = await setup(t, (call) => call.provider === 'claude' ? error(429, 'rate_limit_error', 'too many tokens per minute') : ok(call.provider));
  const r = await post(h);
  assert.equal(r.json.model, 'gpt-6.1-sol');
  assert.equal(r.headers.get('x-router-fallback'), 'claude:rate_limited');
  assert.deepEqual(calls.map((call) => call.provider), ['claude', 'openai']);
  await h.settle();
});

for (const [model, upstream] of [['kimi-k3.1-pro', 'morph-kimik31'], ['deepseek-v4.1-flash', 'morph-dsv41flash'], ['morph-kimik31', 'morph-kimik31'], ['morph-dsv41flash', 'morph-dsv41flash']]) {
  test(`${model} echoes its ID in every streamed chunk and preserves tool calls`, async (t) => {
    const tool = { tool_calls: [{ index: 0, id: 'call_lookup', type: 'function', function: { name: 'lookup', arguments: '{}' } }] };
    const { h, calls } = await setup(t, () => sse([chunk({ role: 'assistant' }), chunk(tool), chunk({}, 'tool_calls'), '[DONE]']));
    const r = await post(h, { model, stream: true });
    assert.equal(r.status, 200);
    const chunks = r.text.split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)));
    assert.equal(chunks.length, 3);
    assert.ok(chunks.every((item) => item.model === model));
    assert.deepEqual(chunks[1].choices[0].delta, tool);
    assert.equal(calls[0].model, upstream);
    assert.equal(calls[0].body.reasoning_effort, undefined);
    assert.equal(calls[0].body.stream_options.include_usage, true);
    await h.settle();
  });
}

for (const stream of [false, true]) {
  test(`included upstream errors preserve text and machine-readable provider IDs with stream=${stream}`, async (t) => {
    const info = { code: 'morph_capacity_error', message: `Morph capacity exceeded for morph-kimik31; see https://api.morphllm.com/docs; key ${KEYS.MORPH_API_KEY}` };
    const { h } = await setup(t, () => stream ? sse([chunk(), { error: info }]) : error(503, info.code, info.message));
    const r = await post(h, { model: 'kimi-k3.1-pro', stream });
    assert.equal(r.status, stream ? 200 : 503);
    const envelope = stream ? JSON.parse(r.text.split('\n').find((line) => line.startsWith('data: {\"error\":')).slice(6)) : r.json;
    assert.equal(envelope.error.message, info.message.replace(KEYS.MORPH_API_KEY, '[redacted]'));
    assert.equal(envelope.error.code, info.code);
    assert.equal(envelope.error.provider, 'morph');
    assert.equal(r.headers.get('x-router-provider'), 'morph');
    assert.doesNotMatch(r.text, /fake-SENTINEL/);
    await h.settle();
  });
}

test('included key and configuration errors use public wording and keep internal health IDs', async () => {
  const empty = await makeHarness();
  const missing = await post(empty, { model: 'kimi-k3.1-pro' });
  assert.equal(missing.status, 503);
  assert.equal(missing.json.error.code, 'provider_not_configured');
  assert.match(missing.json.error.message, /included/);
  assert.equal(missing.json.error.message, 'Provider \"included\" has no API key: set MORPH_API_KEY on the server or store one with \"mrouter keys set included\".');
  const health = await empty.call('/control/health', { headers: bearer() });
  assert.deepEqual(health.json.providers.morph, { configured: false });
  const unknown = await empty.call('/control/keys/unknown', { method: 'DELETE', headers: bearer() });
  assert.equal(unknown.status, 400);
  await empty.settle();
  for (const env of [{ MORPH_API_KEY: 'short' }, { MORPH_API_KEY_2: 'short' }, { MORPH_BASE_URL: 'invalid' }]) {
    const h = await makeHarness({ env });
    const r = await h.call('/v1/models', { headers: bearer() });
    assert.equal(r.status, 503);
    assert.ok(r.json.error.message.includes(Object.keys(env)[0]));
    await h.settle();
  }
  for (const verified of [false, null]) {
    const h = await makeHarness({ verifyProviderKey: async () => ({ verified, upstream_status: verified === false ? 401 : 503 }) });
    const r = await h.call('/control/keys/morph', { method: 'PUT', headers: bearer(), body: JSON.stringify({ key: 'fake-SENTINEL-included-key-12345', verify: true }) });
    assert.equal(r.status, verified === false ? 400 : 502);
    assert.equal(r.json.error.provider, 'morph');
    assert.match(r.json.error.message, /included/);
    assert.doesNotMatch(r.json.error.message, /morph/i);
    assert.equal(h.store.dump().provider_keys.length, 0);
    await h.settle();
  }
});
