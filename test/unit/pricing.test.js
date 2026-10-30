import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRICING, SMOKE_MODELS, costOf, modelList, priceEntry } from '../../src/pricing.js';
import { normalizeUsage, recordUsage, usageEntries } from '../../src/usage.js';

const NOW = Date.parse('2026-10-21T12:00:00Z');
/** @param {Partial<import('../../src/pricing.js').Usage>} u */
const usage = (u) => ({ prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, ...u });

test('pricing.json: dated, sourced per provider, every entry well-formed; smoke models are listed', () => {
  assert.match(PRICING.updated, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(Object.keys(PRICING.sources).sort(), ['claude', 'gemini', 'openai', 'openrouter']);
  for (const [id, e] of Object.entries(PRICING.models)) {
    assert.ok(['claude', 'gemini', 'openai', 'openrouter'].includes(e.provider), id);
    if (e.priced === false) continue;
    for (const f of /** @type {const} */ (['input', 'output', 'cache_read', 'cache_write'])) {
      assert.ok(e[f] === null || (typeof e[f] === 'number' && e[f] >= 0), `${id}.${f}`);
    }
    for (const f of /** @type {const} */ (['image_input', 'text_output'])) {
      assert.ok(e[f] === undefined || e[f] === null || (typeof e[f] === 'number' && e[f] >= 0), `${id}.${f}`);
    }
    for (const f of e.assumed ?? []) assert.equal(typeof e[/** @type {'input'} */ (f)], 'number', `${id} assumed ${f}`);
    if (e.provider !== 'openai') assert.equal(typeof e.sampling, 'boolean', id);
    if (e.provider === 'claude') assert.equal(e.cache_write, Math.round(e.input * 1.25 * 1e6) / 1e6, `${id} cache_write = 1.25 x input`);
  }
  for (const [provider, model] of Object.entries(SMOKE_MODELS)) assert.equal(PRICING.models[model]?.provider, provider);
});

test('estimated cost: uncached prompt = prompt - cached - cache writes, each priced at its own rate, in nano-USD', () => {
  // claude-haiku-5-5: input 0.10, cache_read 0.01, cache_write 0.125, output 0.50 USD / 1M tokens
  const u = usage({ prompt_tokens: 2500, cached_tokens: 2000, cache_write_tokens: 400, completion_tokens: 50 });
  assert.deepEqual(costOf('claude', 'claude-haiku-5-5', u, NOW), { status: 'estimated', nusd: 100 * 100 + 2000 * 10 + 400 * 125 + 50 * 500 });
  // gemini-2.5-flash-lite: input 0.10, cache_read 0.01, output 0.40; cache_write null but unused
  const g = usage({ prompt_tokens: 1200, cached_tokens: 200, completion_tokens: 300 });
  assert.deepEqual(costOf('gemini', 'gemini-2.5-flash-lite', g, NOW), { status: 'estimated', nusd: 1000 * 100 + 200 * 10 + 300 * 400 });
  assert.deepEqual(costOf('gemini', 'gemini-2.5-flash-lite', usage({}), NOW), { status: 'estimated', nusd: 0 });
});

test('Gemini smoke model: gemini-3.5-flash-lite at the official Standard rates; gemini-2.5-flash-lite still priced', () => {
  // gemini-2.5-flash-lite answers 404 to new accounts. Rates: official Gemini API pricing page,
  // 2026-10-22, Standard paid tier: input 0.30, output (incl. thinking) 2.50, caching 0.03 USD / 1M.
  assert.equal(SMOKE_MODELS.gemini, 'gemini-3.5-flash-lite');
  const e = PRICING.models[SMOKE_MODELS.gemini];
  assert.deepEqual([e.provider, e.input, e.output, e.cache_read, e.tiers], ['gemini', 0.3, 2.5, 0.03, undefined]);
  const u = usage({ prompt_tokens: 1200, cached_tokens: 200, completion_tokens: 300 });
  assert.deepEqual(costOf('gemini', SMOKE_MODELS.gemini, u, NOW), { status: 'estimated', nusd: 1000 * 300 + 200 * 30 + 300 * 2500 });
  assert.ok(priceEntry('gemini', 'gemini-2.5-flash-lite', NOW), 'existing accounts and recorded usage still price it');
});

test('prompt-size tiers apply strictly above the threshold, to every token of the request', () => {
  const at = usage({ prompt_tokens: 200000, completion_tokens: 1000 });
  const above = usage({ prompt_tokens: 200001, completion_tokens: 1000 });
  assert.equal(costOf('gemini', 'gemini-2.5-pro', at, NOW).nusd, 200000 * 1250 + 1000 * 10000);
  assert.equal(costOf('gemini', 'gemini-2.5-pro', above, NOW).nusd, 200001 * 2500 + 1000 * 15000);
  const haiku = usage({ prompt_tokens: 100001, cached_tokens: 1, completion_tokens: 10 });
  assert.equal(costOf('claude', 'claude-haiku-5-5', haiku, NOW).nusd, 100000 * 500 + 1 * 50 + 10 * 2500);
});

test('unknown cost: unknown or unpriced model, wrong provider, past valid_until, a needed price that is null', () => {
  const u = usage({ prompt_tokens: 10, completion_tokens: 10 });
  const unknown = { status: 'unknown', nusd: 0 };
  assert.deepEqual(costOf('claude', 'claude-sonnet-4-5', u, NOW), unknown);
  assert.deepEqual(costOf('openrouter', 'openrouter/auto', u, NOW), unknown, 'priced:false and no usage.cost');
  assert.deepEqual(costOf('gemini', 'claude-haiku-5-5', u, NOW), unknown);
  assert.deepEqual(costOf('claude', '__proto__', u, NOW), unknown);
  assert.equal(costOf('gemini', 'gemini-4-argon', u, Date.parse('2026-11-30T23:59:59Z')).status, 'estimated');
  assert.deepEqual(costOf('gemini', 'gemini-4-argon', u, Date.parse('2026-12-01T00:00:00Z')), unknown);
  assert.equal(priceEntry('gemini', 'gemini-4-argon', Date.parse('2026-12-01T00:00:00Z')), null);
  assert.deepEqual(costOf('gemini', 'gemini-2.5-flash', usage({ prompt_tokens: 10, cache_write_tokens: 5 }), NOW), unknown, 'cache_write is null');
});

test('provider-reported OpenRouter usage.cost is exact (credits = USD), even for unlisted models', () => {
  assert.deepEqual(costOf('openrouter', 'vendor/any-model', usage({ prompt_tokens: 1, cost: 0.00123 }), NOW), { status: 'exact', nusd: 1230000 });
  assert.deepEqual(costOf('openrouter', 'vendor/any-model', usage({ cost: 0 }), NOW), { status: 'exact', nusd: 0 });
  assert.equal(costOf('gemini', 'gemini-2.5-flash', usage({ cost: 1 }), NOW).status, 'estimated', 'only OpenRouter reports cost');
});

test('model list: configured providers only, OpenAI shape, context_length/max_output_tokens when known', () => {
  const claudeOnly = modelList((p) => p === 'claude');
  assert.ok(claudeOnly.length > 0 && claudeOnly.every((m) => m.owned_by === 'claude' && m.object === 'model' && m.created === 0));
  assert.deepEqual(
    claudeOnly.find((m) => m.id === 'claude-haiku-4-5'),
    { id: 'claude-haiku-4-5', object: 'model', created: 0, owned_by: 'claude', context_length: 200000, max_output_tokens: 64000 },
  );
  const gemini = modelList((p) => p === 'gemini');
  assert.equal(gemini.find((m) => m.id === 'gemini-2.5-pro')?.context_length, 1048576);
  assert.ok(!('context_length' in /** @type {object} */ (gemini.find((m) => m.id === 'gemini-4-argon'))), 'unknown context length is omitted');
  assert.deepEqual(modelList(() => false), []);
});

test('normalizeUsage reads OpenAI/OpenRouter usage; malformed counts become 0', () => {
  assert.deepEqual(
    normalizeUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      cost: 0.00123,
      prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 7 },
      completion_tokens_details: { reasoning_tokens: 30 },
    }),
    { prompt_tokens: 1000, completion_tokens: 200, cached_tokens: 100, cache_write_tokens: 7, reasoning_tokens: 30, cost: 0.00123 },
  );
  assert.deepEqual(normalizeUsage({ prompt_tokens: -1, completion_tokens: '5' }), usage({}));
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage([1]), null);
});

test('usage recording: one addUsage of the non-zero counters on the UTC day, purging days before the 400 kept', async () => {
  const base = { provider: 'claude', model: 'claude-haiku-5-5', nowMs: NOW };
  const entry = (/** @type {string} */ metric, /** @type {number} */ value) => ({ provider: 'claude', model: 'claude-haiku-5-5', metric, value });
  const u = usage({ prompt_tokens: 2500, cached_tokens: 2000, cache_write_tokens: 400, completion_tokens: 50 });
  assert.deepEqual(usageEntries({ ...base, error: false, billable: true, usage: u, usageFinal: true }), [
    entry('requests', 1),
    entry('prompt_tokens', 2500),
    entry('completion_tokens', 50),
    entry('cached_tokens', 2000),
    entry('cache_write_tokens', 400),
    entry('cost_nusd', 105000),
    entry('cost_estimated', 1),
  ]);
  const metrics = (/** @type {Parameters<typeof usageEntries>[0]} */ r) => usageEntries(r).map((e) => `${e.metric}=${e.value}`);
  assert.deepEqual(metrics({ ...base, error: false, billable: true, usage: null, usageFinal: false }), ['requests=1', 'usage_missing=1', 'cost_unknown=1']);
  assert.deepEqual(metrics({ ...base, error: true, billable: false, usage: null, usageFinal: false }), ['requests=1', 'errors=1']);
  assert.deepEqual(
    metrics({ ...base, error: true, billable: true, usage: usage({ prompt_tokens: 9 }), usageFinal: false }),
    ['requests=1', 'errors=1', 'prompt_tokens=9', 'cost_unknown=1'],
    'partial usage of a stream cut short: tokens counted, cost unknown',
  );
  /** @type {unknown[][]} */
  const calls = [];
  /** @type {Promise<unknown>[]} */
  const background = [];
  const ctx = { now: () => NOW, store: { addUsage: async (/** @type {unknown[]} */ ...args) => void calls.push(args) }, waitUntil: (/** @type {Promise<unknown>} */ p) => background.push(p) };
  recordUsage(ctx, { provider: 'claude', model: 'claude-haiku-5-5', error: true, billable: false, usage: null, usageFinal: false });
  await Promise.all(background);
  assert.deepEqual(calls, [['2026-10-21', [entry('requests', 1), entry('errors', 1)], { retainFromDay: '2025-09-17' }]], '2025-09-17 .. 2026-10-21 is 400 days');
});
