// Model name -> provider (DESIGN §5.3). First match wins:
//   contains "/" -> openrouter (model forwarded unchanged), "claude-" -> claude, "gemini-" -> gemini.
import { GatewayError } from './http.js';

export const INCLUDED_MODELS = Object.freeze({
  'kimi-k3.1-pro': 'morph-kimik31',
  'deepseek-v4.1-flash': 'morph-dsv41flash',
});

export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

const RULES =
  'Route by model name: a name containing "/" goes to OpenRouter (e.g. "openrouter/free", "vendor/model:free"), ' +
  '"kimi-k3.1-pro" or "deepseek-v4.1-flash" to the included provider, "claude-" to Claude, "gemini-" to Gemini, or "gpt-" or o followed by a digit to OpenAI.';

/**
 * @param {unknown} model
 * @returns {string}
 */
function validModel(model) {
  if (model === undefined || model === null || model === '') {
    throw new GatewayError(400, 'model_required', 'The request body must include "model".');
  }
  if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) {
    throw new GatewayError(400, 'invalid_model', 'Invalid model name: use 1-128 characters from A-Z a-z 0-9 . _ : / @ + - starting with a letter or digit.');
  }
  return model;
}

/**
 * @param {unknown} name
 * @returns {{provider: 'claude' | 'gemini' | 'openrouter' | 'openai' | 'morph', model: string, upstreamModel?: string}}
 */
export function routeModel(name) {
  const model = validModel(name);
  const included = Object.entries(INCLUDED_MODELS).find(([id, upstream]) => model === id || model === upstream);
  if (included) return { provider: 'morph', model, upstreamModel: included[1] };
  if (model.startsWith('morph-')) {
    throw new GatewayError(400, 'model_not_allowed', 'Included models accept only: ' + Object.keys(INCLUDED_MODELS).join(', ') + '.');
  }
  if (model.includes('/')) {
    if (model !== 'openrouter/free' && !model.endsWith(':free')) {
      throw new GatewayError(400, 'model_not_allowed', 'OpenRouter accepts only models ending in :free or openrouter/free.');
    }
    return { provider: 'openrouter', model };
  }
  if (model.startsWith('claude-')) return { provider: 'claude', model };
  if (model.startsWith('gemini-')) return { provider: 'gemini', model };
  if (model.startsWith('gpt-') || /^o\d/.test(model)) return { provider: 'openai', model };
  throw new GatewayError(400, 'model_not_routable', `Model "${model}" is not routable. ${RULES}`);
}

/**
 * @param {unknown} name
 * @returns {{provider: 'openai', model: string}}
 */
export function routeImageModel(name) {
  const model = validModel(name);
  if (!model.startsWith('gpt-image-')) {
    throw new GatewayError(400, 'model_not_routable', `Model "${model}" cannot generate images. Image generation accepts only OpenAI models starting with "gpt-image-".`);
  }
  return { provider: 'openai', model };
}

export const AUTOMATIC_CHAIN = Object.freeze([
  Object.freeze({ provider: 'claude', model: 'claude-opus-5-5' }),
  Object.freeze({ provider: 'openai', model: 'gpt-6-astra' }),
  Object.freeze({ provider: 'morph', model: 'deepseek-v4.1-flash' }),
]);

export function retryableBilling(status, info) {
  if (![401, 402, 403, 429].includes(status)) return false;
  const text = [info.code, info.message, ...(info.reasons ?? [])].join(' ');
  return /insufficient_quota|credit|billing|payment|balance|quota.{0,60}(?:exhaust|daily|monthly|per.day)|(?:exhaust|insufficient|daily|monthly).{0,60}quota/i.test(text);
}

const SAFETY_OR_CONTEXT_ERROR = /context[_ -]?(?:length|window)|prompt.{0,20}too long|maximum context|content[_ -]?(?:policy|filter)|safety|refusal|(?:prompt|input)[_ -]too[_ -]long/i;
const FALLBACK_RULES = [
  { reason: null, matches: ({ success, committed, aborted }) => success || committed || aborted },
  { reason: null, matches: ({ info }) => SAFETY_OR_CONTEXT_ERROR.test([info.code, info.message, ...(info.reasons ?? [])].join(' ')) },
  { reason: null, matches: ({ status, info }) => status == null && ['authentication_error', 'permission_error', 'invalid_request_error', 'not_found_error'].some((code) => [info.code, ...info.reasons].includes(code)) },
  { reason: 'not_configured', matches: ({ configured }) => configured === false },
  { reason: 'unavailable', matches: ({ network }) => network },
  { reason: null, matches: ({ status }) => [400, 404, 413, 422].includes(status) },
  { reason: 'quota_exhausted', matches: ({ status, info }) => status === 402 || retryableBilling(status, info) || [info.code, ...info.reasons].includes('insufficient_quota') || (status == null && [info.code, ...info.reasons].includes('billing_error')) },
  { reason: 'rate_limited', matches: ({ status, info }) => status === 429 || (status == null && ['rate_limit_error', 'rate_limit_exceeded'].some((code) => [info.code, ...info.reasons].includes(code))) },
  { reason: null, matches: ({ status }) => status === 401 || status === 403 },
  { reason: 'unavailable', matches: ({ status, info }) => [500, 502, 503, 504, 529].includes(status) || (status == null && ['api_error', 'overloaded_error', 'timeout_error', 'server_error'].some((code) => [info.code, ...info.reasons].includes(code))) },
];

export function classifyFallback(failure = {}) {
  const info = failure.info ?? {};
  const input = { ...failure, info: { ...info, reasons: [...(info.reasons ?? []), ...(info.signals ?? [])] } };
  return FALLBACK_RULES.find((rule) => rule.matches(input))?.reason ?? null;
}

const MAX_COOLDOWN_END_MS = 8_640_000_000_000_000n;

export function cooldownEnd(retryAfter, nowMs) {
  const text = typeof retryAfter === 'string' ? retryAfter.trim() : '';
  const now = BigInt(nowMs);
  let end = now + 30_000n;
  if (/^\d+$/.test(text)) end = now + BigInt(text) * 1000n;
  else if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) {
    const date = Date.parse(text);
    if (Number.isFinite(date) && new Date(date).toUTCString() === text) end = BigInt(date);
  }
  if (end < now + 1000n) end = now + 1000n;
  return Number(end > MAX_COOLDOWN_END_MS ? MAX_COOLDOWN_END_MS : end);
}
