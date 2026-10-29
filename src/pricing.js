// Price lookup and cost estimation (DESIGN §7). Data: src/pricing.json (USD per 1M tokens, dated
// and sourced). Costs are integer nano-USD. Unknown models, missing prices and entries past their
// `valid_until` date are never priced (not even as zero).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * @typedef {{input: number | null, output: number | null, cache_read: number | null, cache_write: number | null}} Prices
 * @typedef {Prices & {provider: string, priced?: boolean, assumed?: string[], valid_until?: string,
 *   tiers?: (Prices & {above_prompt_tokens: number})[], context_length: number | null, max_output: number | null,
 *   sampling?: boolean, reasoning_effort?: boolean}} PriceEntry
 * @typedef {{prompt_tokens: number, completion_tokens: number, cached_tokens: number, cache_write_tokens: number,
 *   reasoning_tokens: number, cost?: number}} Usage normalized usage; prompt_tokens includes cached and cache-write tokens
 */

/** @type {{updated: string, sources: Record<string, string>, smoke_models: Record<string, string>, models: Record<string, PriceEntry>}} */
export const PRICING = require('./pricing.json');
export const SMOKE_MODELS = Object.freeze({ ...PRICING.smoke_models });

/**
 * The table entry for a model of a provider (regardless of validity), or null.
 * @param {string} provider
 * @param {string} model
 * @returns {PriceEntry | null}
 */
export function modelInfo(provider, model) {
  const entry = Object.hasOwn(PRICING.models, model) ? PRICING.models[model] : null;
  return entry && entry.provider === provider ? entry : null;
}

/**
 * An entry usable for estimation today, or null (unknown, unpriced or past `valid_until`).
 * @param {string} provider
 * @param {string} model
 * @param {number} nowMs
 */
export function priceEntry(provider, model, nowMs) {
  const entry = modelInfo(provider, model);
  if (!entry || entry.priced === false) return null;
  if (entry.valid_until && new Date(nowMs).toISOString().slice(0, 10) >= entry.valid_until) return null;
  return entry;
}

/** @param {PriceEntry} entry @param {number} promptTokens @returns {Prices} */
function pricesFor(entry, promptTokens) {
  let prices = /** @type {Prices} */ (entry);
  for (const tier of [...(entry.tiers ?? [])].sort((a, b) => a.above_prompt_tokens - b.above_prompt_tokens)) {
    if (promptTokens > tier.above_prompt_tokens) prices = tier;
  }
  return prices;
}

/**
 * Cost of one request, in priority order: provider-reported (OpenRouter `usage.cost`, USD) ->
 * exact; price table -> estimated; otherwise unknown.
 * @param {string} provider
 * @param {string} model
 * @param {Usage} usage
 * @param {number} nowMs
 * @returns {{status: 'exact' | 'estimated' | 'unknown', nusd: number}}
 */
export function costOf(provider, model, usage, nowMs) {
  if (provider === 'openrouter' && typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0) {
    return { status: 'exact', nusd: Math.round(usage.cost * 1e9) };
  }
  const entry = priceEntry(provider, model, nowMs);
  if (!entry) return { status: 'unknown', nusd: 0 };
  const prices = pricesFor(entry, usage.prompt_tokens);
  const uncached = Math.max(usage.prompt_tokens - usage.cached_tokens - usage.cache_write_tokens, 0);
  /** @type {[number, number | null][]} */
  const parts = [
    [uncached, prices.input],
    [usage.cached_tokens, prices.cache_read],
    [usage.cache_write_tokens, prices.cache_write],
    [usage.completion_tokens, prices.output],
  ];
  let nusd = 0;
  for (const [tokens, price] of parts) {
    if (tokens === 0) continue;
    if (typeof price !== 'number') return { status: 'unknown', nusd: 0 };
    nusd += tokens * price * 1000; // USD per 1M tokens -> nano-USD per token is price * 1000
  }
  return { status: 'estimated', nusd: Math.round(nusd) };
}

/**
 * OpenAI model list entries for the providers that are configured, in table order.
 * @param {(provider: string) => boolean} configured
 */
export function modelList(configured) {
  const data = [];
  for (const [id, entry] of Object.entries(PRICING.models)) {
    if (!configured(entry.provider)) continue;
    /** @type {Record<string, unknown>} */
    const m = { id, object: 'model', created: 0, owned_by: entry.provider };
    if (typeof entry.context_length === 'number') m.context_length = entry.context_length;
    if (typeof entry.max_output === 'number') m.max_output_tokens = entry.max_output;
    data.push(m);
  }
  return data;
}
