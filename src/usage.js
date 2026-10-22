// Usage recording and aggregation (DESIGN §7). The row format is the contract: one counter per
//   (UTC day, provider, model, metric) in usage_daily, added to atomically, kept 400 days.
// Besides BASE_METRICS, recording writes `cache_write_tokens` and `usage_missing`; aggregation
// sums any well-formed metric, so both appear in /control/usage rows when non-zero.
import { GatewayError } from './http.js';
import { costOf } from './pricing.js';

/** Days kept, today included: exactly the days /control/usage can ask for. */
export const MAX_USAGE_DAYS = 400;
export const DEFAULT_USAGE_DAYS = 30;
/** Metrics every aggregate row reports (0 when absent). Other well-formed metrics are summed too. */
export const BASE_METRICS = Object.freeze([
  'requests',
  'errors',
  'prompt_tokens',
  'completion_tokens',
  'cached_tokens',
  'reasoning_tokens',
  'cost_nusd',
  'cost_exact',
  'cost_estimated',
  'cost_unknown',
]);
const METRIC_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const RESERVED = new Set(['provider', 'model', 'cost_usd', 'cost_status']);
const DAY_MS = 86400000;

/** @param {number} ms @returns {string} UTC YYYY-MM-DD */
export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
/** The oldest UTC day kept when recording at `nowMs`. @param {number} nowMs */
export const retainFromDay = (nowMs) => utcDay(nowMs - (MAX_USAGE_DAYS - 1) * DAY_MS);

/**
 * Resolve `?days=N` (1..400, default 30) or `?since=YYYY-MM-DD` (inclusive, at most 400 days) to UTC days.
 * @param {URLSearchParams} params
 * @param {number} nowMs
 * @returns {{from: string, to: string, days: string[]}}
 */
export function usageDays(params, nowMs) {
  const invalid = (/** @type {string} */ m) => new GatewayError(400, 'invalid_parameter', m);
  const daysParam = params.get('days');
  const since = params.get('since');
  if (daysParam !== null && since !== null) throw invalid('Use either days or since, not both.');
  const today = Date.parse(`${utcDay(nowMs)}T00:00:00Z`);
  let count = DEFAULT_USAGE_DAYS;
  if (since !== null) {
    const start = /^\d{4}-\d{2}-\d{2}$/.test(since) ? Date.parse(`${since}T00:00:00Z`) : NaN;
    if (!Number.isFinite(start) || utcDay(start) !== since) throw invalid('since must be a date in YYYY-MM-DD form.');
    if (start > today) throw invalid('since must not be in the future.');
    count = (today - start) / DAY_MS + 1;
    if (count > MAX_USAGE_DAYS) throw invalid(`since must be at most ${MAX_USAGE_DAYS} days ago (inclusive).`);
  } else if (daysParam !== null) {
    count = /^[1-9]\d{0,2}$/.test(daysParam) ? Number(daysParam) : NaN;
    if (!(count >= 1 && count <= MAX_USAGE_DAYS)) throw invalid(`days must be an integer from 1 to ${MAX_USAGE_DAYS}.`);
  }
  const days = [];
  for (let i = count - 1; i >= 0; i--) days.push(utcDay(today - i * DAY_MS));
  return { from: days[0], to: days[days.length - 1], days };
}

/**
 * exact | estimated | mixed | unknown | partial (= some requests unknown, total is a lower bound)
 * @param {Record<string, number>} row
 */
export function costStatus(row) {
  const exact = row.cost_exact ?? 0;
  const estimated = row.cost_estimated ?? 0;
  const unknown = row.cost_unknown ?? 0;
  if (unknown > 0) return exact + estimated > 0 ? 'partial' : 'unknown';
  if (exact > 0 && estimated > 0) return 'mixed';
  if (exact > 0) return 'exact';
  if (estimated > 0) return 'estimated';
  return (row.requests ?? 0) > 0 ? 'unknown' : 'exact'; // never claim a priced zero for unclassified requests
}

/** @param {Record<string, string>} labels */
function newRow(labels) {
  /** @type {Record<string, any>} */
  const row = { ...labels };
  for (const m of BASE_METRICS) row[m] = 0;
  return row;
}

/** @param {Record<string, any>} into @param {Record<string, any>} from */
function addMetrics(into, from) {
  for (const [k, v] of Object.entries(from)) if (typeof v === 'number') into[k] = (into[k] ?? 0) + v;
}

/** @param {Record<string, any>} row */
function finish(row) {
  return { ...row, cost_usd: Number((row.cost_nusd / 1e9).toFixed(9)), cost_status: costStatus(row) };
}

/**
 * @param {readonly {provider: unknown, model: unknown, metric: unknown, value: unknown}[]} counters
 *   store rows (any days); malformed ones are skipped
 */
export function aggregateUsage(counters) {
  /** @type {Map<string, Record<string, any>>} */
  const rows = new Map();
  for (const c of counters) {
    if (!c || typeof c !== 'object') continue;
    const { provider, model, metric, value } = c;
    if (typeof provider !== 'string' || typeof model !== 'string' || typeof metric !== 'string') continue;
    if (!Number.isSafeInteger(value) || !METRIC_NAME.test(metric) || RESERVED.has(metric)) continue;
    const id = JSON.stringify([provider, model]);
    let row = rows.get(id);
    if (!row) rows.set(id, (row = newRow({ provider, model })));
    row[metric] = (row[metric] ?? 0) + /** @type {number} */ (value);
  }
  const sorted = [...rows.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
  /** @type {Map<string, Record<string, any>>} */
  const byProvider = new Map();
  const totals = newRow({});
  for (const row of sorted) {
    let p = byProvider.get(row.provider);
    if (!p) byProvider.set(row.provider, (p = newRow({ provider: row.provider })));
    addMetrics(p, row);
    addMetrics(totals, row);
  }
  return { models: sorted.map(finish), providers: [...byProvider.values()].map(finish), totals: finish(totals) };
}

/** @param {unknown} v */
const count = (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);

/**
 * OpenAI-shaped `usage` (Gemini, OpenRouter, and the Claude adapter's output) -> normalized usage.
 * @param {unknown} u
 * @returns {import('./pricing.js').Usage | null}
 */
export function normalizeUsage(u) {
  if (!u || typeof u !== 'object' || Array.isArray(u)) return null;
  const o = /** @type {Record<string, any>} */ (u);
  /** @type {import('./pricing.js').Usage} */
  const usage = {
    prompt_tokens: count(o.prompt_tokens),
    completion_tokens: count(o.completion_tokens),
    cached_tokens: count(o.prompt_tokens_details?.cached_tokens),
    cache_write_tokens: count(o.prompt_tokens_details?.cache_write_tokens),
    reasoning_tokens: count(o.completion_tokens_details?.reasoning_tokens),
  };
  if (typeof o.cost === 'number') usage.cost = o.cost;
  return usage;
}

/**
 * The usage counters of one forwarded request (non-zero metrics only).
 *   usage known and final -> tokens + cost (exact | estimated | unknown);
 *   usage partial (stream cut short) -> tokens, cost unknown;
 *   no usage but the provider may have billed (success, timeout, abort, broken stream)
 *     -> usage_missing + cost unknown;
 *   no usage and nothing billable (upstream HTTP error, unreachable) -> requests/errors only.
 * @param {{provider: string, model: string, nowMs: number, error: boolean, billable: boolean,
 *   usage: import('./pricing.js').Usage | null, usageFinal: boolean}} r
 * @returns {{provider: string, model: string, metric: string, value: number}[]}
 */
export function usageEntries({ provider, model, nowMs, error, billable, usage, usageFinal }) {
  /** @type {Record<string, number>} */
  const m = { requests: 1, errors: error ? 1 : 0 };
  if (usage) {
    m.prompt_tokens = usage.prompt_tokens;
    m.completion_tokens = usage.completion_tokens;
    m.cached_tokens = usage.cached_tokens;
    m.cache_write_tokens = usage.cache_write_tokens;
    m.reasoning_tokens = usage.reasoning_tokens;
    const cost = usageFinal ? costOf(provider, model, usage, nowMs) : { status: 'unknown', nusd: 0 };
    m.cost_nusd = cost.nusd;
    m[`cost_${cost.status}`] = 1;
  } else if (billable) {
    m.usage_missing = 1;
    m.cost_unknown = 1;
  }
  return Object.entries(m)
    .filter(([, n]) => n > 0)
    .map(([metric, value]) => ({ provider, model, metric, value }));
}

/**
 * Record in the background (one store statement via waitUntil, which also purges days older
 * than 400); never fails the request.
 * @param {any} ctx
 * @param {Omit<Parameters<typeof usageEntries>[0], 'nowMs'>} r
 */
export function recordUsage(ctx, r) {
  if (!ctx.store) return;
  const nowMs = ctx.now();
  ctx.waitUntil(ctx.store.addUsage(utcDay(nowMs), usageEntries({ ...r, nowMs }), { retainFromDay: retainFromDay(nowMs) }));
}
