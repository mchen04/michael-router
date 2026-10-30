import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GatewayError } from '../../src/http.js';
import { PRICING, costOf } from '../../src/pricing.js';
import { openai } from '../../src/providers/passthrough.js';
import { routeImageModel } from '../../src/routing.js';
import { normalizeImageUsage, usageEntries } from '../../src/usage.js';

const NOW = Date.parse('2026-10-29T12:00:00Z');
/** @param {Record<string, any>} body */
const sent = (body) => JSON.parse(openai.prepareImages(body).payload);

test('routeImageModel: gpt-image- names route to OpenAI; every other name is a 400 in the routing style', () => {
  assert.deepEqual(routeImageModel('gpt-image-2.5-sunburst'), { provider: 'openai', model: 'gpt-image-2.5-sunburst' });
  assert.deepEqual(routeImageModel('gpt-image-2-2026-04-21'), { provider: 'openai', model: 'gpt-image-2-2026-04-21' });
  /** @param {unknown} model @param {string} code */
  const refused = (model, code) => assert.throws(() => routeImageModel(model), (err) => err instanceof GatewayError && err.status === 400 && err.code === code, String(model));
  for (const model of ['gpt-6-luna', 'dall-e-3', 'chatgpt-image-latest', 'gemini-2.5-flash-image', 'openrouter/free', 'gpt-imagine']) refused(model, 'model_not_routable');
  refused(undefined, 'model_required');
  refused('', 'model_required');
  refused(42, 'invalid_model');
  refused('gpt image', 'invalid_model');
});

test('prepareImages: jpeg at 80 by default, webp for a transparent background, explicit choices untouched', () => {
  assert.deepEqual(openai.prepareImages({ model: 'gpt-image-2', prompt: 'p' }).adjusted, ['output_format=jpeg', 'output_compression=80']);
  assert.deepEqual(sent({ model: 'gpt-image-2', prompt: 'p' }), { model: 'gpt-image-2', prompt: 'p', output_format: 'jpeg', output_compression: 80 });
  assert.equal(sent({ background: 'transparent' }).output_format, 'webp');
  assert.deepEqual(sent({ output_compression: 30 }), { output_format: 'jpeg', output_compression: 30 });
  assert.deepEqual(openai.prepareImages({ output_format: 'png' }).adjusted, []);
  assert.deepEqual(sent({ output_format: 'webp' }), { output_format: 'webp' });
});

test('prepareImages: n is capped by estimated image size and format; smaller requests are untouched', () => {
  assert.equal(sent({ n: 10, size: '1024x1024' }).n, 5);
  assert.equal(sent({ n: 10 }).n, 3, 'auto assumes the largest standard size');
  assert.equal(sent({ n: 10, size: '3840x2160' }).n, 1);
  assert.equal(sent({ n: 10, size: '1024x1024', output_format: 'png' }).n, 1);
  assert.equal(sent({ n: 10, size: '256x256', output_format: 'png' }).n, 10);
  assert.equal(sent({ n: 2, size: '1024x1024' }).n, 2);
  assert.equal(sent({ size: '1024x1024' }).n, undefined);
  assert.equal(sent({ n: 'many' }).n, 'many', 'malformed n is left for the provider to reject');
  assert.deepEqual(openai.prepareImages({ n: 10, size: '1024x1024', output_format: 'jpeg' }).adjusted, ['n=5']);
});

test('normalizeImageUsage maps Images API usage; image models are priced per token kind', () => {
  const u = normalizeImageUsage({ input_tokens: 300, output_tokens: 4260, input_tokens_details: { text_tokens: 100, image_tokens: 200 }, output_tokens_details: { image_tokens: 4160, text_tokens: 100 } }, 2);
  assert.deepEqual(u, { prompt_tokens: 300, completion_tokens: 4260, cached_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, image_input_tokens: 200, text_output_tokens: 100, images: 2 });
  assert.equal(normalizeImageUsage(null, 1), null);
  assert.deepEqual(costOf('openai', 'gpt-image-1.5', /** @type {any} */ (u), NOW), { status: 'estimated', nusd: 100 * 5000 + 200 * 8000 + 4160 * 32000 + 100 * 10000 });
  assert.deepEqual(costOf('openai', 'gpt-image-2', /** @type {any} */ (u), NOW), { status: 'unknown', nusd: 0 }, 'gpt-image-2 has no text output price');
  const plain = /** @type {any} */ (normalizeImageUsage({ input_tokens: 50, output_tokens: 1000 }, 1));
  assert.deepEqual(costOf('openai', 'gpt-image-1-mini', plain, NOW), { status: 'estimated', nusd: 50 * 2000 + 1000 * 8000 });
  assert.deepEqual(costOf('openai', 'gpt-6-luna', { ...plain, image_input_tokens: 5 }, NOW), { status: 'unknown', nusd: 0 }, 'chat models have no image input price');
  const metrics = usageEntries({ provider: 'openai', model: 'gpt-image-1-mini', nowMs: NOW, error: false, billable: true, usage: plain, usageFinal: true }).map((e) => `${e.metric}=${e.value}`);
  assert.deepEqual(metrics, ['requests=1', 'prompt_tokens=50', 'completion_tokens=1000', 'images=1', 'cost_nusd=8100000', 'cost_estimated=1']);
});

test('pricing.json: the current gpt-image models at official Standard per-token prices', () => {
  /** @type {Record<string, [number, number, number, number, number | null]>} input, cached input, image input, image output, text output */
  const expected = {
    'gpt-image-2.5-sunburst': [5, 1.25, 8, 30, null],
    'gpt-image-2.5-flare': [5, 1.25, 8, 30, null],
    'gpt-image-2': [5, 1.25, 8, 30, null],
    'gpt-image-1.5': [5, 1.25, 8, 32, 10],
    'gpt-image-1-mini': [2, 0.2, 2.5, 8, null],
  };
  for (const [model, prices] of Object.entries(expected)) {
    const e = PRICING.models[model];
    assert.deepEqual([e.provider, e.input, e.cache_read, e.image_input, e.output, e.text_output], ['openai', ...prices], model);
  }
  assert.equal(PRICING.models['gpt-image-1'], undefined, 'gpt-image-1 was shut down on 2026-10-23');
});
