import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { bearer, fakeClock } from '../helpers/fixtures.js';
import { makeHarness } from '../helpers/harness.js';

const primary = 'primary-SENTINEL-openai-key';
const fallback = 'fallback-SENTINEL-openai-key';
const IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const usage = { input_tokens: 50, output_tokens: 4160, total_tokens: 4210, input_tokens_details: { text_tokens: 50, image_tokens: 0 } };
let server;
let url;
let requests = [];
let answer;
const success = (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ created: 1, output_format: req.body.output_format, data: Array.from({ length: req.body.n ?? 1 }, () => ({ b64_json: IMAGE })), usage }));
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
const harness = (extra = {}) => makeHarness({ clock: fakeClock(), env: { OPENAI_API_KEY: primary, OPENAI_API_KEY_2: fallback, OPENAI_BASE_URL: url, ...extra } });
const generate = (h, body, headers = {}) => h.call('/v1/images/generations', { method: 'POST', headers: { ...bearer(), ...headers }, body: JSON.stringify({ prompt: 'a lighthouse', ...body }) });
const usageReport = async (h) => { await h.settle(); return (await h.call('/control/usage?days=1', { headers: bearer() })).json; };

test('image generation forwards to the OpenAI Images API with only provider auth and records usage and cost', async () => {
  const h = await harness();
  const result = await generate(h, { model: 'gpt-image-2', size: '1024x1024' }, { cookie: 'private', 'openai-organization': 'private' });
  assert.equal(result.status, 200, result.text);
  assert.equal(result.headers.get('x-router-provider'), 'openai');
  assert.equal(result.json.data[0].b64_json, IMAGE, 'base64 image data is never redacted');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/v1/images/generations');
  assert.equal(requests[0].headers.authorization, `Bearer ${primary}`);
  assert.equal(requests[0].headers.cookie, undefined);
  assert.equal(requests[0].headers['openai-organization'], undefined);
  assert.equal(requests[0].body.prompt, 'a lighthouse');
  const report = await usageReport(h);
  const row = report.models.find((m) => m.model === 'gpt-image-2');
  assert.equal(row.provider, 'openai');
  assert.deepEqual([row.requests, row.errors, row.prompt_tokens, row.completion_tokens, row.images], [1, 0, 50, 4160, 1]);
  assert.equal(row.cost_estimated, 1);
  assert.equal(row.cost_nusd, 50 * 5000 + 4160 * 30000);
  assert.equal(row.key_slot_1_requests, 1);
});

test('an omitted output_format defaults to jpeg at compression 80 (webp with a transparent background); client choices are kept', async () => {
  const h = await harness();
  const defaulted = await generate(h, { model: 'gpt-image-1-mini' });
  assert.equal(defaulted.status, 200);
  assert.deepEqual([requests[0].body.output_format, requests[0].body.output_compression], ['jpeg', 80]);
  assert.equal(defaulted.headers.get('x-router-adjusted-params'), 'output_format=jpeg, output_compression=80');
  await generate(h, { model: 'gpt-image-1-mini', background: 'transparent' });
  assert.deepEqual([requests[1].body.output_format, requests[1].body.output_compression], ['webp', 80]);
  await generate(h, { model: 'gpt-image-1-mini', output_compression: 50 });
  assert.deepEqual([requests[2].body.output_format, requests[2].body.output_compression], ['jpeg', 50]);
  const chosen = await generate(h, { model: 'gpt-image-1-mini', output_format: 'png' });
  assert.equal(requests[3].body.output_format, 'png');
  assert.equal(Object.hasOwn(requests[3].body, 'output_compression'), false);
  assert.equal(chosen.headers.get('x-router-adjusted-params'), null);
});

test('n is capped so the response stays under the Vercel limit', async () => {
  const h = await harness();
  const capped = await generate(h, { model: 'gpt-image-2', size: '1024x1024', n: 10 });
  assert.equal(requests[0].body.n, 5);
  assert.equal(capped.json.data.length, 5);
  assert.match(String(capped.headers.get('x-router-adjusted-params')), /n=5$/);
  await generate(h, { model: 'gpt-image-2', size: '1024x1024', output_format: 'png', n: 3 });
  assert.equal(requests[1].body.n, 1);
  await generate(h, { model: 'gpt-image-2', size: '1024x1024', n: 2 });
  assert.equal(requests[2].body.n, 2);
});

test('only gpt-image- models are accepted; streaming is refused; nothing reaches the provider', async () => {
  const h = await harness();
  for (const [body, code] of [
    [{ model: 'gpt-6-luna' }, 'model_not_routable'],
    [{ model: 'dall-e-3' }, 'model_not_routable'],
    [{ model: 'chatgpt-image-latest' }, 'model_not_routable'],
    [{ model: 'claude-haiku-5-5' }, 'model_not_routable'],
    [{ model: 'vendor/image:free' }, 'model_not_routable'],
    [{}, 'model_required'],
    [{ model: 'gpt image' }, 'invalid_model'],
    [{ model: 'gpt-image-2', stream: true }, 'unsupported_parameter'],
  ]) {
    const result = await generate(h, body);
    assert.equal(result.status, 400, code);
    assert.deepEqual([result.json.error.type, result.json.error.code], ['gateway_error', code]);
    assert.equal(result.headers.get('x-router-error-source'), 'gateway');
  }
  assert.match((await generate(h, { model: 'dall-e-3' })).json.error.message, /starting with "gpt-image-"/);
  const unconfigured = await makeHarness({ env: { OPENAI_BASE_URL: url } });
  assert.equal((await generate(unconfigured, { model: 'gpt-image-2' })).json.error.code, 'provider_not_configured');
  assert.equal(requests.length, 0);
});

test('upstream errors map like chat errors and count as errors without cost', async () => {
  const h = await harness();
  for (const [status, body, expected, code, headers] of [
    [400, { error: { code: 'moderation_blocked', message: 'Your request was rejected by the safety system.' } }, 400, 'moderation_blocked', {}],
    [401, { error: { message: 'Incorrect API key provided' } }, 502, 'provider_auth_failed', {}],
    [403, { error: { message: 'Your organization must be verified to use gpt-image-2.' } }, 403, 'provider_forbidden', {}],
    [429, { error: { code: 'rate_limit_exceeded', message: 'Too many requests' } }, 429, 'provider_rate_limited', { 'retry-after': '7' }],
    [500, { error: { message: 'The server had an error' } }, 500, 'provider_error', {}],
  ]) {
    requests = [];
    answer = (req, res) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    const result = await generate(h, { model: 'gpt-image-2' });
    assert.equal(result.status, expected, code);
    assert.deepEqual([result.json.error.type, result.json.error.code, result.json.error.provider, result.json.error.upstream_status], ['upstream_error', code, 'openai', status]);
    assert.equal(result.headers.get('x-router-error-source'), 'upstream');
    assert.equal(requests.length, 1, `${status} is not retried`);
    if (headers['retry-after']) assert.equal(result.headers.get('retry-after'), '7');
  }
  answer = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"created":1}'); };
  const unreadable = await generate(h, { model: 'gpt-image-2' });
  assert.deepEqual([unreadable.status, unreadable.json.error.code], [502, 'provider_error']);
  const row = (await usageReport(h)).models.find((m) => m.model === 'gpt-image-2');
  assert.deepEqual([row.requests, row.errors, row.cost_nusd, row.usage_missing], [6, 6, 0, 1]);
});

test('a billing refusal retries once with the fallback key; a plain rate limit does not', async () => {
  answer = (req, res) => {
    if (req.headers.authorization === `Bearer ${primary}`) { res.writeHead(429); res.end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.' } })); }
    else success(req, res);
  };
  const h = await harness();
  const result = await generate(h, { model: 'gpt-image-2' });
  assert.equal(result.status, 200, result.text);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].headers.authorization, `Bearer ${fallback}`);
  assert.deepEqual(requests[0].body, requests[1].body);
  const totals = (await usageReport(h)).totals;
  assert.deepEqual([totals.requests, totals.key_slot_2_requests, totals.cost_estimated], [1, 1, 1]);
  requests = [];
  answer = (req, res) => { res.writeHead(429); res.end('{"error":{"code":"rate_limit_exceeded","message":"Too many requests"}}'); };
  assert.equal((await generate(h, { model: 'gpt-image-2' })).status, 429);
  assert.equal(requests.length, 1);
});

test('keys are scrubbed from image responses while base64 data passes through; oversized responses are refused with usage kept', async () => {
  const h = await harness();
  answer = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ created: 1, data: [{ b64_json: IMAGE, revised_prompt: `echo ${primary}` }, { b64_json: `${fallback}${IMAGE}` }], usage })); };
  const result = await generate(h, { model: 'gpt-image-2' });
  assert.equal(result.status, 200);
  assert.ok(!result.text.includes(primary) && !result.text.includes(fallback));
  assert.equal(result.json.data[0].b64_json, IMAGE);
  answer = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ created: 1, data: [{ b64_json: 'A'.repeat(4_600_000) }], usage })); };
  const large = await generate(h, { model: 'gpt-image-2', output_format: 'png' });
  assert.deepEqual([large.status, large.json.error.code, large.json.error.type], [502, 'response_too_large', 'gateway_error']);
  const row = (await usageReport(h)).models.find((m) => m.model === 'gpt-image-2');
  assert.deepEqual([row.requests, row.errors, row.completion_tokens, row.cost_estimated], [2, 1, 8320, 2]);
});

test('GET /v1/models lists the priced image models when OpenAI is configured', async () => {
  const h = await harness();
  const ids = (await h.call('/v1/models', { headers: bearer() })).json.data.map((m) => m.id);
  for (const model of ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1-mini']) assert.ok(ids.includes(model), model);
});
