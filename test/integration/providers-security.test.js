import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { ROUTES } from '../../src/handler.js';
import { PRICING, SMOKE_MODELS } from '../../src/pricing.js';
import { bearer, fakeClock, WRONG_PASSWORD } from '../helpers/fixtures.js';
import { makeHarness } from '../helpers/harness.js';

const primary = 'primary-SENTINEL-provider-key';
const fallback = 'fallback-SENTINEL-provider-key';
const providers = [
  ['claude', 'ANTHROPIC', 'claude-haiku-5-5'],
  ['gemini', 'GEMINI', 'gemini-2.5-flash'],
  ['openrouter', 'OPENROUTER', 'openrouter/free'],
  ['openai', 'OPENAI', 'gpt-6-luna'],
];
let server;
let url;
let requests = [];
let answer;
const usage = { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 100 } };
const completion = { id: 'fake', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }], usage };
const chunk = (data) => `data: ${JSON.stringify(data)}\n\n`;
const success = (req, res) => {
  if (req.body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chunk({ choices: [{ delta: { content: 'pong' }, finish_reason: 'stop' }] }) + chunk({ choices: [], usage }) + 'data: [DONE]\n\n');
  } else if (req.url === '/v1/messages') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'fake', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'pong' }], stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 20 } }));
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(completion));
  }
};
before(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const request = { url: req.url, headers: req.headers, raw, body: raw ? JSON.parse(raw) : null };
    requests.push(request);
    answer(request, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
beforeEach(() => { requests = []; answer = success; });
const harness = (extra = {}) => makeHarness({ clock: fakeClock(), env: { ...Object.fromEntries(providers.flatMap(([, env]) => [[`${env}_API_KEY`, primary], [`${env}_API_KEY_2`, fallback], [`${env}_BASE_URL`, url]])), ...extra } });
const chat = (h, model, extra = {}, headers = {}) => h.call('/v1/chat/completions', { method: 'POST', headers: { ...bearer(), ...headers }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], ...extra }) });
const totals = async (h) => { await h.settle(); return (await h.call('/control/usage?days=1', { headers: bearer() })).json.totals; };

for (const stream of [false, true]) test(`OpenAI forwards chat with streaming=${stream}, records usage and only forwards provider authentication`, async () => {
  const h = await harness();
  const result = await chat(h, 'gpt-6-luna', { stream }, { cookie: 'private', 'openai-organization': 'private' });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('x-router-provider'), 'openai');
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].headers.authorization, `Bearer ${primary}`);
  assert.equal(requests[0].headers.cookie, undefined);
  assert.equal(requests[0].headers['openai-organization'], undefined);
  assert.ok(result.text.includes('pong'));
  if (stream) assert.ok(result.text.includes('[DONE]'));
  const row = await totals(h);
  assert.equal(row.prompt_tokens, 1000);
  assert.equal(row.cost_estimated, 1);
  assert.equal(row.key_slot_1_requests, 1);
});

test('OpenRouter refuses paid names and caller-supplied paid alternatives without any upstream call', async () => {
  const h = await harness();
  for (const model of ['openrouter/auto', 'openai/gpt-6-astra', 'vendor/paid', 'vendor/free:free:online']) {
    const result = await chat(h, model);
    assert.equal(result.status, 400, model);
    assert.equal(result.json.error.code, 'model_not_allowed');
  }
  for (const extra of [{ models: ['vendor/paid'] }, { route: 'fallback' }, { plugins: [{ id: 'web' }] }, { preset: 'paid' }]) {
    assert.equal((await chat(h, 'openrouter/free', extra)).status, 400);
  }
  assert.equal(requests.length, 0);
});

test('OpenRouter locks provider prices and alternatives even when the caller supplies a conflicting guard', async () => {
  const h = await harness();
  assert.equal((await chat(h, 'vendor/model:free', { provider: { max_price: { prompt: 100 }, allow_fallbacks: true } })).status, 200);
  assert.deepEqual(requests[0].body.provider.max_price, { prompt: 0, completion: 0, request: 0, image: 0 });
  assert.equal(requests[0].body.provider.allow_fallbacks, false);
  assert.deepEqual(requests[0].body.models, ['vendor/model:free']);
});

for (const [provider, , model] of providers) test(`${provider} retries a billing refusal once with slot 2`, async () => {
  answer = (req, res) => {
    const key = req.headers['x-api-key'] ?? req.headers.authorization?.slice(7);
    if (key === primary) { res.writeHead(429); res.end(JSON.stringify({ error: { code: 'insufficient_quota', message: `Credit balance exhausted: ${primary}` } })); }
    else success(req, res);
  };
  const h = await harness();
  const result = await chat(h, model);
  assert.equal(result.status, 200, result.text);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].headers['x-api-key'] ?? requests[1].headers.authorization?.slice(7), fallback);
  assert.equal((await totals(h)).key_slot_2_requests, 1);
  assert.equal((await totals(h)).requests, 1);
});

for (const status of [401, 402, 403, 429]) test(`billing refusal HTTP ${status} retries, plain rate limit does not`, async () => {
  const h = await harness();
  answer = (req, res) => { if (requests.length === 1) { res.writeHead(status); res.end('{"error":{"message":"Billing credits exhausted"}}'); } else success(req, res); };
  assert.equal((await chat(h, 'gpt-6-luna')).status, 200);
  assert.equal(requests.length, 2);
  requests = [];
  answer = (req, res) => { res.writeHead(429); res.end('{"error":{"code":"rate_limit_exceeded","message":"Too many requests"}}'); };
  assert.equal((await chat(h, 'gpt-6-luna')).status, 429);
  assert.equal(requests.length, 1);
});

test('no retry after streaming bytes and at most one fallback attempt', async () => {
  const h = await harness();
  answer = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(chunk({ choices: [{ delta: { content: 'started' } }] }));
    res.end(chunk({ error: { code: 429, message: 'Billing credits exhausted' } }));
  };
  const result = await chat(h, 'gpt-6-luna', { stream: true });
  assert.ok(result.text.includes('started'));
  assert.ok(result.text.includes('error'));
  assert.equal(requests.length, 1);
  requests = [];
  answer = (req, res) => { res.writeHead(402); res.end('{"error":{"message":"No credits remaining"}}'); };
  assert.equal((await chat(h, 'gpt-6-luna')).status, 402);
  assert.equal(requests.length, 2);
});

test('every route and rewrite rejects missing and wrong passwords before accessing providers', async () => {
  for (const route of ROUTES) {
    const path = route.path.replace(':provider', 'openai');
    for (const target of [path, `/api/router?__route=${path.slice(1)}`]) {
      const h = await harness();
      assert.equal((await h.call(target, { method: route.method })).status, 401, target);
      assert.equal((await h.call(target, { method: route.method, headers: bearer(WRONG_PASSWORD) })).status, 401, target);
    }
  }
  assert.equal(requests.length, 0);
});

test('wrong-password limiter covers every route and rewrite', async () => {
  for (const route of ROUTES) {
    for (const rewrite of [false, true]) {
      const h = await harness({ AUTH_MAX_FAILURES: '1' });
      const path = route.path.replace(':provider', 'openai');
      const target = rewrite ? `/api/router?__route=${path.slice(1)}` : path;
      const init = { method: route.method, headers: bearer(WRONG_PASSWORD) };
      assert.equal((await h.call(target, init)).status, 401, target);
      assert.equal((await h.call(target, init)).status, 429, target);
    }
  }
  assert.equal(requests.length, 0);
});

test('cross-site browser requests cannot reach a provider or reveal state', async () => {
  const h = await harness();
  assert.equal((await chat(h, 'gpt-6-luna', {}, { origin: 'https://other.example' })).status, 403);
  assert.equal((await h.call('/control/keys', { headers: { ...bearer(), origin: 'null' } })).status, 403);
  assert.equal((await chat(h, 'gpt-6-luna', {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal(requests.length, 0);
});

test('configured keys never appear in responses, usage, errors or logs, including reflected models', async () => {
  const h = await harness();
  answer = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ...completion, choices: [{ message: { content: `${primary} ${fallback}` } }] })); };
  const reflected = await chat(h, `gpt-${primary}`);
  assert.equal(reflected.status, 200);
  assert.ok(!reflected.text.includes(primary) && !reflected.text.includes(fallback));
  answer = (req, res) => { res.writeHead(400); res.end(JSON.stringify({ error: { code: primary, message: fallback } })); };
  const failed = await chat(h, 'gpt-6-luna');
  assert.ok(!failed.text.includes(primary) && !failed.text.includes(fallback));
  await h.settle();
  for (const path of ['/control/keys', '/control/usage', '/control/errors']) {
    const result = await h.call(path, { headers: bearer() });
    assert.ok(!result.text.includes(primary) && !result.text.includes(fallback), path);
  }
  assert.ok(!JSON.stringify(h.logs).includes(primary));
  assert.ok(!JSON.stringify(h.store.dump()).includes(primary));
});

test('OpenAI pricing includes all requested models with a dated official source', () => {
  for (const model of ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4-nano', 'o3', 'o4-mini']) assert.equal(PRICING.models[model]?.provider, 'openai', model);
  assert.match(PRICING.sources.openai, /developers.openai.com.*2026-10-29/);
  assert.equal(SMOKE_MODELS.openai, 'gpt-6-luna');
});

test('fallback streams start only after an HTTP refusal; primary bytes never reach the client', async () => {
  const h = await harness();
  answer = (req, res) => {
    if (requests.length === 1) { res.writeHead(402); res.end(`{"error":{"message":"No credits ${primary}"}}`); }
    else success(req, res);
  };
  const result = await chat(h, 'gpt-6-luna', { stream: true });
  assert.equal(result.status, 200);
  assert.ok(result.text.includes('[DONE]'));
  assert.ok(!result.text.includes('No credits'));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].body, requests[1].body);
  assert.equal((await totals(h)).key_slot_2_requests, 1);
});

test('invalid keys and ambiguous quotas never retry; missing fallback returns the primary error', async () => {
  const h = await harness();
  for (const [status, message] of [[401, 'Invalid API key'], [403, 'Forbidden'], [429, 'Quota exceeded']]) {
    requests = [];
    answer = (req, res) => { res.writeHead(status); res.end(JSON.stringify({ error: { message } })); };
    await chat(h, 'gpt-6-luna');
    assert.equal(requests.length, 1);
  }
  requests = [];
  const missing = await harness({ OPENAI_API_KEY_2: '' });
  answer = (req, res) => { res.writeHead(402); res.end('{"error":{"message":"No credits remaining"}}'); };
  assert.equal((await chat(missing, 'gpt-6-luna')).status, 402);
  assert.equal(requests.length, 1);
});

test('stream events and gateway errors scrub keys while keeping JSON valid', async () => {
  const h = await harness();
  answer = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(chunk({ choices: [{ delta: { content: primary + fallback } }] }) + 'data: [DONE]\n\n');
  };
  const result = await chat(h, 'gpt-6-luna', { stream: true });
  assert.ok(!result.text.includes(primary) && !result.text.includes(fallback));
  const gateway = await chat(h, primary);
  assert.equal(gateway.status, 400);
  assert.ok(!gateway.text.includes(primary));
});

test('usage labels redact a configured key embedded in a routable Gemini model', async () => {
  const h = await harness();
  assert.equal((await chat(h, `gemini-${primary}`)).status, 200);
  await h.settle();
  const report = await h.call('/control/usage?days=1', { headers: bearer() });
  assert.ok(!report.text.includes(primary));
  assert.ok(!JSON.stringify(h.store.dump()).includes(primary));
});

test('configuration details require a verified password and never bypass the shared limiter', async () => {
  const h = await harness({ OPENAI_API_KEY_2: 'bad key', AUTH_MAX_FAILURES: '1' });
  assert.equal((await h.call('/control/health')).status, 401);
  const wrong = await h.call('/control/health', { headers: bearer(WRONG_PASSWORD) });
  assert.equal(wrong.status, 401);
  assert.ok(!wrong.text.includes('OPENAI_API_KEY_2'));
  assert.equal((await h.call('/v1/models', { headers: bearer(WRONG_PASSWORD) })).status, 429);
  const valid = await harness({ OPENAI_API_KEY_2: 'bad key' });
  const details = await valid.call('/control/health', { headers: bearer() });
  assert.equal(details.status, 503);
  assert.ok(details.text.includes('OPENAI_API_KEY_2'));
});
