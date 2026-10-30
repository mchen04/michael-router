// POST /v1/chat/completions (forwarding, streaming tap, error mapping), POST /v1/images/generations,
// GET /v1/models and provider key verification (DESIGN §5.3-§5.6, §6, §7).
//
// Nothing from the client request is forwarded except the body: upstream requests carry only
// content-type, the provider auth header and user-agent. Every credentialed fetch uses
// `redirect: "error"` (a followed redirect would carry the key to another origin).
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import { PROVIDERS } from './config.js';
import { GatewayError, errorEnvelope, jsonResponse, readBody } from './http.js';
import { modelList } from './pricing.js';
import * as claude from './providers/claude.js';
import { bodyError, createRelay, gemini, openrouter, openai } from './providers/passthrough.js';
import { scrubJson } from './redact.js';
import { routeImageModel, routeModel } from './routing.js';
import { DONE, createSSEParser, serializeJson } from './sse.js';
import { normalizeImageUsage, recordUsage } from './usage.js';
import { VERSION } from './version.js';

export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const UPSTREAM_TIMEOUT_MS = 295_000;
export const VERIFY_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 4_500_000;
const ERROR_BODY_MAX_BYTES = 64 * 1024;
const MESSAGE_MAX = 1000;
const USER_AGENT = `michael-router/${VERSION}`;
const UPSTREAM_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const RETRY_AFTER = /^(\d{1,9}|[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT)$/;
const PASSTHROUGH = { gemini, openrouter, openai };

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** @param {number} ms */
const round1 = (ms) => Math.round(ms * 10) / 10;
/** @param {string} text */
const truncate = (text) => (text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX - 1)}…` : text);
/** @param {string} text */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * @typedef {{provider: 'claude' | 'gemini' | 'openrouter' | 'openai', model: string, headers: Record<string, string>}} Target
 * @typedef {{message?: string, code?: string, httpCode?: number, reasons?: string[]}} UpstreamErrorInfo
 */

/**
 * Message, string code and numeric HTTP code of a provider error object
 * (OpenAI/OpenRouter `{message, type, code}`, Anthropic `{type, message}`, Gemini `{code, message, status}`).
 * @param {Record<string, any>} e
 * @returns {UpstreamErrorInfo}
 */
function errorInfo(e) {
  return {
    message: typeof e.message === 'string' ? e.message : undefined,
    code: [e.code, e.type, e.status].find((c) => typeof c === 'string' && UPSTREAM_CODE.test(c)),
    httpCode: Number.isInteger(e.code) && e.code >= 100 && e.code <= 599 ? e.code : undefined,
    // Google error details: [{"@type": "...ErrorInfo", "reason": "API_KEY_INVALID", ...}]
    reasons: Array.isArray(e.details) ? e.details.map((d) => d?.reason).filter((r) => typeof r === 'string') : [],
  };
}

/**
 * Tolerant parse of an upstream error body: `{error:{…}}`, Anthropic `{type:"error", error:{…}}`,
 * Gemini's array-wrapped `[{error:{…}}]`, or plain text.
 * @param {string} text
 * @returns {UpstreamErrorInfo}
 */
export function parseUpstreamError(text) {
  const json = parseJson(text);
  if (json === undefined) return { message: text.trim() || undefined };
  const e = bodyError(json);
  if (e) return errorInfo(e);
  if (isObject(json) && typeof json.error === 'string') return { message: json.error };
  if (isObject(json)) return errorInfo(json);
  return { message: typeof json === 'string' ? json : undefined };
}

/**
 * DESIGN §5.4 table: the client status and gateway code for an upstream HTTP error
 * (`code` null = use the upstream code, else `provider_error`).
 * @param {string} provider
 * @param {number} status
 * @param {UpstreamErrorInfo} [info] the parsed upstream error (message, Google error reasons)
 * @returns {{status: number, code: string | null}}
 */
export function mapUpstreamStatus(provider, status, info = {}) {
  const p = /** @type {Record<string, typeof gemini>} */ (PASSTHROUGH)[provider];
  if (status === 401 || (p && p.keyInvalid(status, info))) return { status: 502, code: 'provider_auth_failed' };
  if (status === 402) return { status: 402, code: 'provider_billing' };
  if (status === 403) return { status: 403, code: 'provider_forbidden' };
  if (status === 429) return { status: 429, code: 'provider_rate_limited' };
  return { status: status >= 400 && status <= 599 ? status : 502, code: null };
}

export function retryableBilling(status, info) {
  if (![401, 402, 403, 429].includes(status)) return false;
  const text = [info.code, info.message, ...(info.reasons ?? [])].join(' ');
  return /insufficient_quota|credit|billing|payment|balance|quota.{0,60}(?:exhaust|daily|monthly|per.day)|(?:exhaust|insufficient|daily|monthly).{0,60}quota/i.test(text);
}

/**
 * Build the upstream request for a routed model.
 * @param {any} ctx
 * @param {Target} target
 * @param {Record<string, any>} json
 * @param {Uint8Array} bytes
 */
function prepare(ctx, { provider, model }, json, bytes) {
  const baseUrl = ctx.config.providers[provider].baseUrl;
  if (provider === 'claude') {
    const cache = (ctx.request.headers.get('x-router-cache') ?? '').trim().toLowerCase() !== 'off';
    const r = claude.buildRequest(json, { model, cache });
    return {
      url: `${baseUrl}/v1/messages`,
      payload: JSON.stringify(r.body),
      stream: r.stream,
      dropped: r.dropped,
      includeUsage: r.includeUsage,
      stripUsageOnly: false,
    };
  }
  const p = PASSTHROUGH[provider];
  const r = p.prepare(json, bytes);
  return { url: baseUrl + p.chatPath, payload: r.payload, stream: r.stream, dropped: [], includeUsage: false, stripUsageOnly: r.stripUsageOnly };
}

/** @param {any} ctx @param {'claude' | 'gemini' | 'openrouter' | 'openai'} provider */
function requireKey(ctx, provider) {
  if (!ctx.keys[provider].configured) {
    throw new GatewayError(
      503,
      'provider_not_configured',
      `Provider "${provider}" has no API key: set ${PROVIDERS[provider].keyEnv} on the server or store one with "mrouter keys set ${provider}".`,
    );
  }
}

/** POST /v1/chat/completions @param {any} ctx @returns {Promise<Response>} */
export async function chatCompletions(ctx) {
  const { bytes, json } = await readBody(ctx.request, MAX_BODY_BYTES);
  const { provider, model } = routeModel(json.model);
  ctx.log.provider = provider;
  ctx.log.model = model;
  requireKey(ctx, provider);
  /** @type {Target} */
  const target = { provider, model, headers: { 'x-router-provider': provider } };
  const up = prepare(ctx, target, json, bytes);
  if (up.dropped.length) target.headers['x-router-dropped-params'] = up.dropped.join(', ');

  const timeoutMs = ctx.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const deadline = upstreamDeadline(ctx.request.signal, timeoutMs);
  /** @param {unknown} err */
  const broken = (err) => {
    deadline.clear();
    return failure(ctx, target, err, deadline, timeoutMs);
  };
  const started = performance.now();
  let res;
  let raw;
  let body;
  for (let attempt = 0; attempt < 2; attempt++) {
    ctx.keySlot = attempt + 1;
    const key = attempt === 0 ? ctx.keys[provider].key : ctx.config.providers[provider].fallbackKey;
    const auth = provider === 'claude' ? claude.authHeaders(key) : PASSTHROUGH[provider].authHeaders(key);
    try {
      res = await fetch(up.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT, ...auth },
        body: up.payload,
        signal: deadline.signal,
        redirect: 'error',
      });
    } catch (err) {
      return broken(err);
    } finally {
      ctx.timings.upstream = performance.now() - started;
      ctx.log.upstream_ms = round1(ctx.timings.upstream);
    }

    if (!res.ok) {
      const text = await readText(res, ERROR_BODY_MAX_BYTES).catch(() => '');
      const info = parseUpstreamError(text);
      if (attempt === 0 && ctx.config.providers[provider].fallbackKey && retryableBilling(res.status, info) && !deadline.signal.aborted) continue;
      deadline.clear();
      return httpError(ctx, target, res.status, info, res.headers.get('retry-after'));
    }
    const eventStream = /^text\/event-stream\b/i.test(res.headers.get('content-type') ?? '');
    if (up.stream && eventStream && res.body) return relayStream(ctx, target, up, res, deadline, timeoutMs);

    try {
      raw = new Uint8Array(await res.arrayBuffer()); // bytes, not res.text(): pass-through returns them unchanged
    } catch (err) {
      return broken(err);
    }
    body = parseJson(new TextDecoder().decode(raw));
    const err = bodyError(body);
    if (err && !(isObject(body) && (Array.isArray(body.choices) || body.type === 'message'))) {
      // A 2xx carrying only an error (OpenRouter does this) is an error, mapped by its code.
      const info = errorInfo(err);
      if (attempt === 0 && ctx.config.providers[provider].fallbackKey && retryableBilling(info.httpCode, info) && !deadline.signal.aborted) continue;
      deadline.clear();
      return httpError(ctx, target, info.httpCode ?? 502, info, null, res.status);
    }
    break;
  }
  deadline.clear();
  if (up.stream) {
    return upstreamError(ctx, target, { status: 502, code: 'provider_error', message: `${provider} did not return an event stream.`, upstreamStatus: res.status, billable: true });
  }
  if (provider === 'claude') {
    if (!isObject(body) || body.type !== 'message') {
      return upstreamError(ctx, target, { status: 502, code: 'provider_error', message: 'Unreadable response from the Claude API.', upstreamStatus: res.status, billable: true });
    }
    const out = claude.translateResponse(body, { model, created: Math.floor(ctx.now() / 1000) });
    recordUsage(ctx, { provider, model, error: false, billable: true, usage: out.usage, usageFinal: out.usage !== null });
    return new Response(scrubJson(JSON.stringify(out.body), ctx.redact), { status: res.status, headers: { 'content-type': 'application/json; charset=utf-8', ...target.headers } });
  }
  const usage = PASSTHROUGH[provider].usage(isObject(body) ? body.usage : null);
  recordUsage(ctx, { provider, model, error: false, billable: true, usage, usageFinal: usage !== null });
  return new Response(scrubJson(new TextDecoder().decode(raw), ctx.redact), { status: res.status, headers: { 'content-type': ctx.redact(res.headers.get('content-type') ?? 'application/json'), ...target.headers } });
}

/**
 * Scrub an Images API response, passing `b64_json` values through unscrubbed when they are strict
 * base64 (the redactor would replace them as token-like runs; no key fits that alphabet).
 * @param {Record<string, any>} body @param {(text: unknown) => string} redact
 */
function scrubImages(body, redact) {
  const images = body.data.map((/** @type {any} */ d) => (isObject(d) && typeof d.b64_json === 'string' && BASE64.test(d.b64_json) ? d.b64_json : null));
  const rest = { ...body, data: body.data.map((/** @type {any} */ d, /** @type {number} */ i) => (images[i] === null ? d : { ...d, b64_json: '' })) };
  const safe = JSON.parse(scrubJson(JSON.stringify(rest), redact));
  images.forEach((b64, i) => {
    if (b64 !== null) safe.data[i].b64_json = b64;
  });
  return JSON.stringify(safe);
}

/** POST /v1/images/generations (OpenAI gpt-image-* models only) @param {any} ctx @returns {Promise<Response>} */
export async function imageGenerations(ctx) {
  const { json } = await readBody(ctx.request, MAX_BODY_BYTES);
  const { provider, model } = routeImageModel(json.model);
  ctx.log.provider = provider;
  ctx.log.model = model;
  requireKey(ctx, provider);
  if (json.stream === true) throw new GatewayError(400, 'unsupported_parameter', 'Streaming image generation is not supported: omit "stream".');
  /** @type {Target} */
  const target = { provider, model, headers: { 'x-router-provider': provider } };
  const up = openai.prepareImages(json);
  if (up.adjusted.length) target.headers['x-router-adjusted-params'] = up.adjusted.join(', ');

  const timeoutMs = ctx.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const deadline = upstreamDeadline(ctx.request.signal, timeoutMs);
  const started = performance.now();
  let res;
  let raw;
  for (let attempt = 0; attempt < 2; attempt++) {
    ctx.keySlot = attempt + 1;
    const key = attempt === 0 ? ctx.keys[provider].key : ctx.config.providers[provider].fallbackKey;
    try {
      res = await fetch(ctx.config.providers[provider].baseUrl + openai.imagesPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT, ...openai.authHeaders(key) },
        body: up.payload,
        signal: deadline.signal,
        redirect: 'error',
      });
    } catch (err) {
      deadline.clear();
      return failure(ctx, target, err, deadline, timeoutMs);
    } finally {
      ctx.timings.upstream = performance.now() - started;
      ctx.log.upstream_ms = round1(ctx.timings.upstream);
    }
    if (!res.ok) {
      const text = await readText(res, ERROR_BODY_MAX_BYTES).catch(() => '');
      const info = parseUpstreamError(text);
      if (attempt === 0 && ctx.config.providers[provider].fallbackKey && retryableBilling(res.status, info) && !deadline.signal.aborted) continue;
      deadline.clear();
      return httpError(ctx, target, res.status, info, res.headers.get('retry-after'));
    }
    try {
      raw = await res.text();
    } catch (err) {
      deadline.clear();
      return failure(ctx, target, err, deadline, timeoutMs);
    }
    break;
  }
  deadline.clear();
  const body = parseJson(raw);
  if (!isObject(body) || !Array.isArray(body.data)) {
    return upstreamError(ctx, target, { status: 502, code: 'provider_error', message: 'Unreadable response from the OpenAI Images API.', upstreamStatus: res.status, billable: true });
  }
  const usage = normalizeImageUsage(body.usage, body.data.length);
  const out = scrubImages(body, ctx.redact);
  const tooLarge = Buffer.byteLength(out) > MAX_RESPONSE_BYTES;
  recordUsage(ctx, { provider, model, error: tooLarge, billable: true, usage, usageFinal: usage !== null });
  if (tooLarge) {
    throw new GatewayError(
      502,
      'response_too_large',
      `The generated images exceed the ${MAX_RESPONSE_BYTES / 1e6} MB response limit: request fewer images, a smaller size, or output_format "jpeg" or "webp" with a lower output_compression.`,
    );
  }
  return new Response(out, { status: res.status, headers: { 'content-type': 'application/json; charset=utf-8', ...target.headers } });
}

/**
 * The upstream call's signal, aborted when the client leaves or `timeoutMs` after the call started
 * (one deadline for the headers and the whole body). The caller clears it once the call is over:
 * an AbortSignal.timeout would still fire, and allocate its error, long after the call.
 * @param {AbortSignal} clientSignal @param {number} timeoutMs
 */
function upstreamDeadline(clientSignal, timeoutMs) {
  const controller = new AbortController();
  const onClientAbort = () => controller.abort(clientSignal.reason);
  const timer = setTimeout(() => {
    deadline.timedOut = true;
    controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  }, timeoutMs);
  const deadline = {
    signal: controller.signal,
    timedOut: false,
    clear() {
      clearTimeout(timer);
      clientSignal.removeEventListener('abort', onClientAbort);
    },
  };
  if (clientSignal.aborted) onClientAbort();
  else clientSignal.addEventListener('abort', onClientAbort, { once: true });
  return deadline;
}

/** Read at most `max` bytes of a response body as text. @param {Response} res @param {number} max */
async function readText(res, max) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}

/**
 * Upstream HTTP error (or a 2xx error body) -> mapped upstream_error response.
 * @param {any} ctx @param {Target} target @param {number} status @param {UpstreamErrorInfo} info
 * @param {string | null} retryAfter @param {number} [upstreamStatus]
 */
function httpError(ctx, target, status, info, retryAfter, upstreamStatus = status) {
  const mapped = mapUpstreamStatus(target.provider, status, info);
  const upstreamMessage = info.message ?? `HTTP ${upstreamStatus}`;
  const message =
    mapped.code === 'provider_auth_failed'
      ? `The ${target.provider} API rejected the router's API key for this provider (${upstreamMessage}).`
      : upstreamMessage;
  return upstreamError(ctx, target, {
    status: mapped.status,
    code: mapped.code ?? info.code ?? 'provider_error',
    message,
    upstreamStatus,
    headers: retryAfter && RETRY_AFTER.test(retryAfter.trim()) ? { 'retry-after': retryAfter.trim() } : {},
    billable: false,
  });
}

/**
 * A failed fetch or body read: client gone, timeout, or unreachable/broken connection.
 * @param {any} ctx @param {Target} target @param {unknown} err @param {{timedOut: boolean}} deadline @param {number} timeoutMs
 */
function failure(ctx, target, err, deadline, timeoutMs) {
  if (ctx.request.signal.aborted) return clientGone(ctx, target);
  if (deadline.timedOut) {
    const message = `${target.provider} did not respond within ${Math.round(timeoutMs / 1000)} s.`;
    return upstreamError(ctx, target, { status: 504, code: 'upstream_timeout', message, billable: true });
  }
  const cause = /** @type {any} */ (err)?.cause;
  const message = /redirect/i.test(String(cause?.message ?? cause ?? ''))
    ? `${target.provider} answered with a redirect, which the gateway never follows.`
    : `Could not reach ${target.provider}.`;
  return upstreamError(ctx, target, { status: 502, code: 'upstream_unreachable', message, billable: false });
}

/**
 * @param {any} ctx
 * @param {Target} target
 * @param {{status: number, code: string, message: string, upstreamStatus?: number, headers?: Record<string, string>, billable: boolean}} e
 */
function upstreamError(ctx, target, { status, code, message, upstreamStatus, headers = {}, billable }) {
  const scrubbed = truncate(ctx.redact(message));
  code = ctx.redact(code);
  ctx.error = { status, code, recorded: true };
  ctx.events.record({ kind: 'upstream', code, status, upstream_status: upstreamStatus, provider: target.provider, model: target.model });
  recordUsage(ctx, { provider: target.provider, model: target.model, error: true, billable, usage: null, usageFinal: false });
  const envelope = errorEnvelope({ message: scrubbed, code, type: 'upstream_error', provider: target.provider, upstream_status: upstreamStatus });
  return jsonResponse(status, envelope, { ...target.headers, 'x-router-error-source': 'upstream', ...headers });
}

/** The client went away before the upstream answered: nothing to send, no event. @param {any} ctx @param {Target} target */
function clientGone(ctx, target) {
  ctx.error = { status: 499, code: 'client_disconnected', recorded: true };
  recordUsage(ctx, { provider: target.provider, model: target.model, error: false, billable: true, usage: null, usageFinal: false });
  return jsonResponse(499, errorEnvelope({ message: 'Client disconnected.', code: 'client_disconnected' }), target.headers);
}

/**
 * Relay an upstream event stream as OpenAI chat.completion.chunk events. Ends with `[DONE]` only
 * when the upstream completed; an in-stream error, a broken or truncated stream, or a timeout ends
 * it with one error chunk and no `[DONE]`. Usage, events and the log line are written once, at the end.
 * @param {any} ctx @param {Target} target @param {ReturnType<typeof prepare>} up @param {Response} res
 * @param {ReturnType<typeof upstreamDeadline>} deadline client disconnect or upstream timeout, cleared when the stream is finished
 * @param {number} timeoutMs
 */
function relayStream(ctx, target, up, res, deadline, timeoutMs) {
  const { provider, model } = target;
  const { signal } = deadline;
  const tap =
    provider === 'claude'
      ? claude.createStreamTranslator({ model, created: Math.floor(ctx.now() / 1000), includeUsage: up.includeUsage })
      : createRelay({ stripUsageOnly: up.stripUsageOnly, normalize: PASSTHROUGH[provider].usage });
  const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
  const parser = createSSEParser();
  const encoder = new TextEncoder();
  let settled = false;
  /** @type {(v?: unknown) => void} */
  let settle = () => {};
  ctx.waitUntil(new Promise((resolve) => (settle = resolve)));
  ctx.deferLog = true;

  /** @param {{kind: 'done'} | {kind: 'aborted'} | {kind: 'error', code: string, message: string}} outcome */
  const finish = (outcome) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener('abort', onAbort);
    deadline.clear();
    if (outcome.kind === 'error') {
      ctx.error = { status: 200, code: outcome.code, recorded: true };
      ctx.events.record({ kind: 'upstream', code: outcome.code, status: 200, provider, model });
    } else if (outcome.kind === 'aborted') {
      ctx.error = { status: 200, code: 'client_disconnected', recorded: true };
    }
    recordUsage(ctx, { provider, model, error: outcome.kind === 'error', billable: true, usage: tap.usage, usageFinal: tap.usageFinal });
    ctx.finishLog(200);
    settle();
  };
  /** @param {string} code @param {string} message */
  const errorChunk = (code, message) => {
    code = ctx.redact(code);
    const scrubbed = truncate(ctx.redact(message));
    return { text: serializeJson(errorEnvelope({ message: scrubbed, code, type: 'upstream_error', provider })), code, message: scrubbed };
  };
  const timeoutChunk = () => errorChunk('upstream_timeout', `${provider} did not finish within ${Math.round(timeoutMs / 1000)} s.`);
  // Finish (usage, event, log line, waitUntil) as soon as the client leaves or the timeout fires,
  // even if the runtime never pulls or cancels the body again. A later pull still ends the body.
  function onAbort() {
    if (ctx.request.signal.aborted) return finish({ kind: 'aborted' });
    const e = timeoutChunk();
    finish({ kind: 'error', code: e.code, message: e.message });
  }
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  /** @param {ReadableStreamDefaultController<Uint8Array>} controller @param {string} out @param {Parameters<typeof finish>[0]} outcome */
  const end = (controller, out, outcome) => {
    try {
      if (out) controller.enqueue(encoder.encode(out));
      controller.close();
    } catch {
      // the client already cancelled
    }
    finish(outcome);
    reader.cancel().catch(() => {});
  };

  const body = new ReadableStream(
    {
      async pull(controller) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            let out = '';
            for (const item of done ? parser.end() : parser.push(value)) {
              const step = tap.onItem(item);
              if (step.out) out += step.out.split('\n').map((line) => line.startsWith('data: ') ? `data: ${scrubJson(line.slice(6), ctx.redact)}` : ctx.redact(line)).join('\n');
              if (step.error) {
                // Normalized and scrubbed; anything after it (including a [DONE]) is dropped.
                const info = errorInfo(step.error);
                const special = info.httpCode ? mapUpstreamStatus(provider, info.httpCode, info).code : null;
                const e = errorChunk(special ?? info.code ?? 'provider_error', info.message ?? 'Upstream stream error.');
                return end(controller, out + e.text, { kind: 'error', code: e.code, message: e.message });
              }
              if (step.done) return end(controller, out + DONE, { kind: 'done' });
            }
            if (done) {
              const e = errorChunk('upstream_stream_incomplete', `The ${provider} stream ended before it completed.`);
              return end(controller, out + e.text, { kind: 'error', code: e.code, message: e.message });
            }
            if (out) return controller.enqueue(encoder.encode(out));
          }
        } catch {
          if (ctx.request.signal.aborted) return end(controller, '', { kind: 'aborted' });
          const e = deadline.timedOut ? timeoutChunk() : errorChunk('upstream_stream_incomplete', `The ${provider} stream broke before it completed.`);
          end(controller, e.text, { kind: 'error', code: e.code, message: e.message });
        }
      },
      cancel() {
        finish({ kind: 'aborted' });
        reader.cancel().catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', ...target.headers } });
}

/** GET /v1/models: known models of configured providers. @param {any} ctx */
export function listModels(ctx) {
  return jsonResponse(200, { object: 'list', data: modelList((provider) => Boolean(ctx.keys[provider]?.configured)) });
}

/**
 * Verify a key against the provider's model-list endpoint (no token spend): `true` on 2xx, `false`
 * when the provider refused the key (a 4xx other than 408/429), `null` when it could not judge it
 * (408, 429, 5xx). Network failures throw (the caller treats them as `null`).
 * @param {'claude' | 'gemini' | 'openrouter' | 'openai'} provider
 * @param {string} key
 * @param {any} ctx
 * @returns {Promise<{verified: boolean | null, upstream_status: number}>}
 */
export async function verifyProviderKey(provider, key, ctx) {
  const adapter = provider === 'claude' ? claude : PASSTHROUGH[provider];
  const { url, headers } = adapter.verifyRequest(ctx.config.providers[provider].baseUrl, key);
  const signal = AbortSignal.any([AbortSignal.timeout(VERIFY_TIMEOUT_MS), ctx.request.signal]);
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, ...headers }, redirect: 'error', signal });
  await res.body?.cancel().catch(() => {});
  const refused = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
  return { verified: res.ok ? true : refused ? false : null, upstream_status: res.status };
}
