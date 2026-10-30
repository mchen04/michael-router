// Gemini and OpenRouter pass-through specifics (DESIGN §5.4). Request bodies are forwarded as the
// client sent them, except that a streaming Gemini request gets `stream_options.include_usage`.
import { modelInfo } from '../pricing.js';
import { GatewayError } from '../http.js';
import { serializeComment, serializeEvent } from '../sse.js';
import { normalizeUsage } from '../usage.js';

/** Gemini answers 400 (not 401) when the API key itself is invalid or expired. */
const GEMINI_KEY_INVALID = /API key not valid|API key expired|API_KEY_INVALID/i;
const IMAGE_BUDGET_BYTES = 3_000_000;
const PNG_BYTES_PER_PIXEL = 3;
const COMPRESSED_BYTES_PER_PIXEL = 0.5;
const AUTO_IMAGE_PIXELS = 1536 * 1024;
const DEFAULT_IMAGE_COMPRESSION = 80;

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @param {string} key */
const bearer = (key) => ({ authorization: `Bearer ${key}` });

/**
 * The `error` object of an OpenAI-style body (`{error}` or Gemini's `[{error}]`), if any.
 * @param {unknown} json
 * @returns {Record<string, any> | null}
 */
export function bodyError(json) {
  const v = Array.isArray(json) ? json[0] : json;
  return isObject(v) && isObject(v.error) ? v.error : null;
}

/**
 * @typedef {{
 *   chatPath: string,
 *   authHeaders: (key: string) => Record<string, string>,
 *   verifyRequest: (baseUrl: string, key: string) => {url: string, headers: Record<string, string>},
 *   keyInvalid: (status: number, error: {message?: string, reasons?: string[]}) => boolean,
 *   prepare: (body: Record<string, any>, bytes: Uint8Array) => {payload: Uint8Array | string, stream: boolean, stripUsageOnly: boolean},
 *   usage: (u: unknown) => import('../pricing.js').Usage | null,
 * }} PassthroughProvider
 */

/**
 * Gemini usage. Whether `completion_tokens` includes thinking tokens is not documented for the
 * OpenAI-compatible endpoint, while `total_tokens` includes them: bill output as
 * max(completion_tokens, total_tokens − prompt_tokens) and count the difference as reasoning.
 * @param {unknown} u
 */
function geminiUsage(u) {
  const usage = normalizeUsage(u);
  if (!usage) return null;
  const total = /** @type {Record<string, any>} */ (u).total_tokens;
  const hidden = Number.isSafeInteger(total) ? total - usage.prompt_tokens - usage.completion_tokens : 0;
  if (hidden <= 0) return usage;
  return { ...usage, completion_tokens: usage.completion_tokens + hidden, reasoning_tokens: Math.max(usage.reasoning_tokens, hidden) };
}

function prepareChat(body, bytes) {
  if (body.stream !== true) return { payload: bytes, stream: false, stripUsageOnly: false };
  const asked = body.stream_options?.include_usage === true;
  const streamOptions = isObject(body.stream_options) ? body.stream_options : {};
  const payload = JSON.stringify({ ...body, stream_options: { ...streamOptions, include_usage: true } });
  return { payload, stream: true, stripUsageOnly: !asked };
}

/**
 * An Images API body whose base64 response stays under Vercel's 4.5 MB limit: jpeg (webp with a
 * transparent background) at compression 80 unless the client chose a format, and `n` capped by
 * an estimated image size. `adjusted` names each changed field with its new value.
 * @param {Record<string, any>} body
 * @returns {{payload: string, adjusted: string[]}}
 */
function prepareImages(body) {
  const request = { ...body };
  const adjusted = [];
  if (!Object.hasOwn(request, 'output_format')) {
    request.output_format = request.background === 'transparent' ? 'webp' : 'jpeg';
    adjusted.push(`output_format=${request.output_format}`);
    if (!Object.hasOwn(request, 'output_compression')) {
      request.output_compression = DEFAULT_IMAGE_COMPRESSION;
      adjusted.push(`output_compression=${DEFAULT_IMAGE_COMPRESSION}`);
    }
  }
  const size = /^(\d{1,5})x(\d{1,5})$/.exec(String(request.size ?? ''));
  const pixels = size ? Number(size[1]) * Number(size[2]) : AUTO_IMAGE_PIXELS;
  const perPixel = ['jpeg', 'webp'].includes(request.output_format) ? COMPRESSED_BYTES_PER_PIXEL : PNG_BYTES_PER_PIXEL;
  const maxImages = Math.max(1, Math.floor(IMAGE_BUDGET_BYTES / (pixels * perPixel)));
  if (Number.isInteger(request.n) && request.n > maxImages) {
    request.n = maxImages;
    adjusted.push(`n=${maxImages}`);
  }
  return { payload: JSON.stringify(request), adjusted };
}

function defaultEffort(body, native = false) {
  return native || Object.hasOwn(body, 'reasoning_effort') ? body : { ...body, reasoning_effort: 'medium' };
}

/** @type {PassthroughProvider} */
export const gemini = {
  chatPath: '/v1beta/openai/chat/completions',
  authHeaders: bearer,
  verifyRequest: (baseUrl, key) => ({ url: `${baseUrl}/v1beta/openai/models`, headers: bearer(key) }),
  keyInvalid: (status, { message = '', reasons = [] }) => status === 400 && (GEMINI_KEY_INVALID.test(message) || reasons.includes('API_KEY_INVALID')),
  prepare(body, bytes) {
    const thinking = body.extra_body?.google?.thinking_config;
    const native = isObject(thinking) && (Object.hasOwn(thinking, 'thinking_level') || Object.hasOwn(thinking, 'thinking_budget'));
    const request = defaultEffort(body, native);
    return prepareChat(request, request === body ? bytes : JSON.stringify(request));
  },
  usage: geminiUsage,
};

export const openai = {
  chatPath: '/v1/chat/completions',
  authHeaders: bearer,
  verifyRequest: (baseUrl, key) => ({ url: `${baseUrl}/v1/models`, headers: bearer(key) }),
  keyInvalid: () => false,
  prepare(body, bytes) {
    const native = isObject(body.reasoning) && Object.hasOwn(body.reasoning, 'effort');
    let request = defaultEffort(body, native || modelInfo('openai', body.model)?.reasoning_effort === false);
    if (Object.hasOwn(request, 'max_tokens')) {
      const { max_tokens: maxTokens, ...rest } = request;
      request = Object.hasOwn(rest, 'max_completion_tokens') ? rest : { ...rest, max_completion_tokens: maxTokens };
    }
    return prepareChat(request, request === body ? bytes : JSON.stringify(request));
  },
  usage: normalizeUsage,
  imagesPath: '/v1/images/generations',
  prepareImages,
};

/** @type {PassthroughProvider} */
export const openrouter = {
  chatPath: '/api/v1/chat/completions',
  authHeaders: bearer,
  verifyRequest: (baseUrl, key) => ({ url: `${baseUrl}/api/v1/key`, headers: bearer(key) }),
  keyInvalid: () => false,
  prepare(body) {
    if (['models', 'route', 'plugins', 'preset'].some((name) => Object.hasOwn(body, name))) {
      throw new GatewayError(400, 'model_not_allowed', 'OpenRouter model fallbacks, routing overrides, presets and paid plugins are disabled.');
    }
    const provider = isObject(body.provider) ? body.provider : {};
    const payload = JSON.stringify({ ...body, models: [body.model], provider: { ...provider, allow_fallbacks: false, max_price: { prompt: 0, completion: 0, request: 0, image: 0 } } });
    return { payload, stream: body.stream === true, stripUsageOnly: false };
  },
  usage: normalizeUsage,
};

/**
 * The usage the router records for a chat response's OpenAI-shaped `usage` from `provider`
 * (the Claude adapter already emits normalized usage in that shape). The CLI computes its
 * per-request cost with this too, so both agree.
 * @param {string} provider
 * @param {unknown} raw
 */
export function usageFor(provider, raw) {
  const p = provider === 'gemini' ? gemini : provider === 'openrouter' ? openrouter : null;
  return p ? p.usage(raw) : normalizeUsage(raw);
}

/**
 * Relay tap for an OpenAI-style stream: events and comments are relayed as they arrive, `usage`
 * is read from any chunk that carries it, and a chunk with a top-level `error` ends the stream.
 * Usage is final once `[DONE]` arrived, or when it came on a chunk with a `finish_reason` or on
 * the usage-only chunk; usage seen earlier in a stream that then broke is partial.
 * @param {{stripUsageOnly: boolean, normalize?: PassthroughProvider['usage']}} options
 *   stripUsageOnly: drop the usage-only chunk (`choices: []`) the client did not ask for
 */
export function createRelay({ stripUsageOnly, normalize = normalizeUsage }) {
  /** @type {import('../pricing.js').Usage | null} */
  let usage = null;
  let finalChunk = false;
  let done = false;
  return {
    get usage() {
      return usage;
    },
    get usageFinal() {
      return usage !== null && (done || finalChunk);
    },
    /**
     * @param {import('../sse.js').SSEItem} item
     * @returns {import('./claude.js').StreamStep}
     */
    onItem(item) {
      if (!('data' in item)) return { out: serializeComment(item.comment) };
      if (item.data.trim() === '[DONE]') {
        done = true;
        return { done: true };
      }
      let json;
      try {
        json = JSON.parse(item.data);
      } catch {
        return { out: serializeEvent(item) };
      }
      const error = bodyError(json);
      if (error) return { error };
      const usageOnly = isObject(json) && Array.isArray(json.choices) && json.choices.length === 0;
      if (isObject(json) && isObject(json.usage)) {
        usage = normalize(json.usage);
        finalChunk = usageOnly || (Array.isArray(json.choices) && json.choices.some((c) => isObject(c) && c.finish_reason != null));
      }
      if (stripUsageOnly && usageOnly && json.usage) return {};
      return { out: serializeEvent(item) };
    },
  };
}
