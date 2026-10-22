import assert from 'node:assert/strict';
import { test } from 'node:test';
import { USAGE_TTL_SECONDS, aggregateUsage, costStatus, usageDays, usageKey } from '../../src/usage.js';
import { bearer, fakeClock } from '../helpers/fixtures.js';
import { makeHarness } from '../helpers/harness.js';

// 2026-10-21 23:30 in UTC-7 is already 2026-10-22 in UTC.
const NOW = Date.parse('2026-10-22T06:30:00Z');

/** @param {any} store @param {string} day @param {string} provider @param {string} model @param {Record<string, number>} metrics */
function seed(store, day, provider, model, metrics) {
  for (const [metric, n] of Object.entries(metrics)) store.exec(['HINCRBY', usageKey(day), `${provider}\t${model}\t${metric}`, n]);
  store.exec(['EXPIRE', usageKey(day), USAGE_TTL_SECONDS]);
}

test('usageDays: UTC days, days/since bounds (max 400), default 30', () => {
  const p = (/** @type {string} */ q) => new URLSearchParams(q);
  assert.deepEqual(usageDays(p('days=3'), NOW), { from: '2026-10-20', to: '2026-10-22', days: ['2026-10-20', '2026-10-21', '2026-10-22'] });
  assert.equal(usageDays(p(''), NOW).days.length, 30);
  assert.equal(usageDays(p('days=400'), NOW).days.length, 400);
  assert.deepEqual(usageDays(p('since=2026-10-22'), NOW).days, ['2026-10-22']);
  assert.equal(usageDays(p('since=2025-09-18'), NOW).days.length, 400);
  assert.equal(usageDays(p('since=2025-09-18'), NOW).from, '2025-09-18');
  assert.equal(usageDays(p('since=2024-02-29'), Date.parse('2024-03-01T00:00:00Z')).days.length, 2, 'leap day');
  for (const q of ['days=0', 'days=401', 'days=-1', 'days=1.5', 'days=abc', 'days=', 'since=2025-09-17', 'since=2026-10-23', 'since=2026-02-30', 'since=20261001', 'days=3&since=2026-10-01']) {
    assert.throws(() => usageDays(p(q), NOW), (/** @type {any} */ e) => e.status === 400 && e.code === 'invalid_parameter', q);
  }
});

test('costStatus edge cases (the common classes are checked through GET /control/usage below)', () => {
  assert.equal(costStatus({ requests: 3, cost_exact: 1, cost_unknown: 2 }), 'partial');
  assert.equal(costStatus({ requests: 0 }), 'exact');
  assert.equal(costStatus({ requests: 1 }), 'unknown', 'unclassified requests are never a priced zero');
});

test('aggregateUsage ignores malformed fields and sums arbitrary well-formed metrics', () => {
  const out = aggregateUsage([
    ['claude\tclaude-x\trequests', '2', 'claude\tclaude-x\tusage_missing', '1', 'bad-field', '5', 'claude\tclaude-x\tprompt_tokens', 'NaN'],
    null,
    ['claude\tclaude-x\trequests', '3', 'claude\tclaude-x\tprovider', '9', 'claude\tclaude-x\tBad-Metric', '1'],
  ]);
  assert.equal(out.models.length, 1);
  assert.equal(out.models[0].requests, 5);
  assert.equal(out.models[0].usage_missing, 1);
  assert.equal(out.models[0].prompt_tokens, 0);
  assert.equal(out.models[0].provider, 'claude');
});

test('GET /control/usage: per-model sums, cost_status, provider and total rollups over UTC days', async () => {
  const clock = fakeClock(NOW);
  const h = await makeHarness({ clock });
  const s = h.store;
  // in range for days=3: 2026-10-20 .. 2026-10-22 (UTC)
  seed(s, '2026-10-22', 'openrouter', 'anthropic/claude-sonnet-4.5', { requests: 2, prompt_tokens: 100, completion_tokens: 50, cost_nusd: 1500000, cost_exact: 2 });
  seed(s, '2026-10-21', 'openrouter', 'anthropic/claude-sonnet-4.5', { requests: 1, prompt_tokens: 10, completion_tokens: 5, cost_nusd: 500000, cost_exact: 1 });
  seed(s, '2026-10-21', 'claude', 'claude-haiku-4-5', { requests: 4, prompt_tokens: 400, cached_tokens: 100, completion_tokens: 40, cost_nusd: 2000000, cost_estimated: 4 });
  seed(s, '2026-10-20', 'gemini', 'gemini-2.5-flash', { requests: 3, errors: 1, prompt_tokens: 30, completion_tokens: 3, reasoning_tokens: 7, cost_nusd: 100, cost_estimated: 2, cost_unknown: 1 });
  seed(s, '2026-10-20', 'gemini', 'gemini-unknown-model', { requests: 1, prompt_tokens: 5, cost_unknown: 1, usage_missing: 1 });
  seed(s, '2026-10-22', 'openrouter', 'openrouter/auto', { requests: 1, cost_nusd: 10, cost_exact: 1 });
  seed(s, '2026-10-21', 'openrouter', 'openrouter/auto', { requests: 1, cost_nusd: 20, cost_estimated: 1 });
  // out of range for days=3
  seed(s, '2026-10-19', 'claude', 'claude-haiku-4-5', { requests: 100, cost_nusd: 999999999, cost_estimated: 100 });

  const r = await h.call('/control/usage?days=3', { headers: bearer() });
  assert.equal(r.status, 200);
  assert.equal(r.json.from, '2026-10-20');
  assert.equal(r.json.to, '2026-10-22');
  assert.equal(r.json.days, 3);
  const byModel = Object.fromEntries(r.json.models.map((/** @type {any} */ m) => [`${m.provider}/${m.model}`, m]));
  assert.deepEqual(Object.keys(byModel), [
    'claude/claude-haiku-4-5',
    'gemini/gemini-2.5-flash',
    'gemini/gemini-unknown-model',
    'openrouter/anthropic/claude-sonnet-4.5',
    'openrouter/openrouter/auto',
  ]);
  const sonnet = byModel['openrouter/anthropic/claude-sonnet-4.5'];
  assert.equal(sonnet.requests, 3);
  assert.equal(sonnet.prompt_tokens, 110);
  assert.equal(sonnet.completion_tokens, 55);
  assert.equal(sonnet.cost_nusd, 2000000);
  assert.equal(sonnet.cost_usd, 0.002);
  assert.equal(sonnet.cost_status, 'exact');
  assert.equal(byModel['claude/claude-haiku-4-5'].requests, 4, 'day outside the range is excluded');
  assert.equal(byModel['claude/claude-haiku-4-5'].cached_tokens, 100);
  assert.equal(byModel['claude/claude-haiku-4-5'].cost_status, 'estimated');
  assert.equal(byModel['gemini/gemini-2.5-flash'].cost_status, 'partial');
  assert.equal(byModel['gemini/gemini-2.5-flash'].reasoning_tokens, 7);
  assert.equal(byModel['gemini/gemini-2.5-flash'].errors, 1);
  assert.equal(byModel['gemini/gemini-unknown-model'].cost_status, 'unknown');
  assert.equal(byModel['gemini/gemini-unknown-model'].usage_missing, 1);
  assert.equal(byModel['openrouter/openrouter/auto'].cost_status, 'mixed');

  const providers = Object.fromEntries(r.json.providers.map((/** @type {any} */ p) => [p.provider, p]));
  assert.equal(providers.gemini.requests, 4);
  assert.equal(providers.gemini.cost_status, 'partial');
  assert.equal(providers.openrouter.cost_status, 'mixed');
  assert.equal(providers.openrouter.cost_nusd, 2000030);
  assert.equal(r.json.totals.requests, 13);
  assert.equal(r.json.totals.cost_nusd, 4000130);
  assert.equal(r.json.totals.cost_usd, 0.00400013);
  assert.equal(r.json.totals.cost_status, 'partial');

  const wide = await h.call('/control/usage?since=2026-10-19', { headers: bearer() });
  assert.equal(wide.json.totals.requests, 113);
  assert.equal(wide.json.days, 4);
  const today = await h.call('/control/usage?days=1', { headers: bearer() });
  assert.equal(today.json.from, '2026-10-22', 'UTC day, not local');
  assert.equal(today.json.totals.requests, 3);
  const empty = await h.call('/control/usage?since=2026-10-22', { headers: { ...bearer() } });
  assert.equal(empty.json.models.length, 2);
  const bad = await h.call('/control/usage?days=401', { headers: bearer() });
  assert.deepEqual([bad.status, bad.json.error.code], [400, 'invalid_parameter'], 'usageDays bounds are tested above');
});
