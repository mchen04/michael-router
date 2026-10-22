// Chat requests for `ask` and `test`: stream consumption, response assembly, per-request cost.
// Usage and cost use the same normalization (src/providers/passthrough.js) and price table
// (src/pricing.js) the router records with: provider-reported (OpenRouter usage.cost) is exact,
// the price table gives an estimate, anything else is unknown.
import { performance } from 'node:perf_hooks';
import { costOf } from '../../src/pricing.js';
import { createSSEParser } from '../../src/sse.js';
import { usageFor } from '../../src/providers/passthrough.js';
import { clean } from './http.js';
import { CliError, EXIT } from './errors.js';

/**
 * @typedef {import('../../src/pricing.js').Usage} Usage
 * @typedef {{usd: number, status: 'exact' | 'estimated' | 'unknown'}} Cost
 * @typedef {{onContent?: (text: string) => void, onReasoning?: (text: string) => void}} StreamHandlers
 * @typedef {{response: Record<string, any>, done: boolean, error: Record<string, any> | null, ttfbMs: number,
 *   totalMs: number}} StreamResult
 */

/** @param {string} text */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * @param {string | null} provider
 * @param {string} model the requested model (what the router records usage under)
 * @param {unknown} rawUsage
 * @returns {{usage: Usage | null, cost: Cost}}
 */
export function requestCost(provider, model, rawUsage) {
  const usage = usageFor(provider ?? '', rawUsage);
  if (!usage || !provider) return { usage, cost: { usd: 0, status: 'unknown' } };
  const c = costOf(provider, model, usage, Date.now());
  return { usage, cost: { usd: c.nusd / 1e9, status: c.status } };
}

/**
 * Read a chat-completion event stream to its end (`[DONE]`, an error event, or EOF), passing
 * content and reasoning deltas to the handlers as they arrive, and assemble the equivalent
 * non-streaming response.
 * @param {Response} res
 * @param {number} t0 performance.now() at request start
 * @param {StreamHandlers} handlers
 * @param {(err: unknown) => CliError} onBroken maps a broken connection to an error
 * @returns {Promise<StreamResult>}
 */
export async function consumeStream(res, t0, handlers, onBroken) {
  const parser = createSSEParser();
  /** @type {Record<string, any>} */
  const head = {};
  let content = '';
  let reasoning = '';
  /** @type {Record<string, any>[]} */
  const toolCalls = [];
  /** @type {string | null} */
  let finish = null;
  /** @type {unknown} */
  let usage = null;
  let done = false;
  /** @type {Record<string, any> | null} */
  let error = null;
  /** @type {number | undefined} */
  let ttfbMs;

  /** @param {import('../../src/sse.js').SSEItem} item */
  const handle = (item) => {
    if (!('data' in item)) return; // comment lines such as ": OPENROUTER PROCESSING"
    if (item.data === '[DONE]') {
      done = true;
      return;
    }
    const chunk = parseJson(item.data);
    if (!chunk || typeof chunk !== 'object') return;
    if (chunk.error && typeof chunk.error === 'object') {
      error = chunk.error;
      return;
    }
    for (const k of ['id', 'created', 'model']) if (head[k] === undefined && chunk[k] !== undefined) head[k] = chunk[k];
    if (chunk.usage) usage = chunk.usage;
    for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
      if ((choice?.index ?? 0) !== 0) continue;
      const d = choice.delta ?? {};
      const r = d.reasoning_content ?? d.reasoning;
      if (typeof r === 'string' && r !== '') {
        reasoning += r;
        handlers.onReasoning?.(r);
      }
      if (typeof d.content === 'string' && d.content !== '') {
        content += d.content;
        handlers.onContent?.(d.content);
      }
      for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        const i = Number.isInteger(tc?.index) ? tc.index : 0;
        const call = (toolCalls[i] ??= { id: undefined, type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.function.name += tc.function.name;
        if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  };

  const reader = /** @type {ReadableStream<Uint8Array>} */ (res.body).getReader();
  try {
    reading: for (;;) {
      const { done: eof, value } = await reader.read();
      ttfbMs ??= performance.now() - t0;
      for (const item of eof ? parser.end() : parser.push(value)) {
        handle(item);
        if (done || error) break reading;
      }
      if (eof) break;
    }
  } catch (err) {
    throw onBroken(err);
  } finally {
    reader.cancel().catch(() => {});
  }
  /** @type {Record<string, unknown>} */
  const message = { role: 'assistant', content: content === '' && toolCalls.length ? null : content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls.filter(Boolean);
  const response = {
    id: head.id,
    object: 'chat.completion',
    created: head.created,
    model: head.model,
    choices: [{ index: 0, message, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
  return { response, done, error, ttfbMs: ttfbMs ?? performance.now() - t0, totalMs: performance.now() - t0 };
}

/**
 * The error for a stream that failed after its 200 status: an in-stream error event (exit 4) or
 * an end without `[DONE]` (the connection was cut: exit 5).
 * @param {StreamResult} r
 * @param {string | null} provider
 * @returns {CliError | null}
 */
export function streamFailure(r, provider) {
  if (r.error) {
    const code = typeof r.error.code === 'string' ? clean(r.error.code) : 'stream_error';
    const message = typeof r.error.message === 'string' ? clean(r.error.message) : 'no message';
    const who = clean(r.error.provider ?? provider ?? 'provider');
    return new CliError(`upstream error from ${who} during the stream (${code}): ${message}`, EXIT.UPSTREAM, { status: 200, code });
  }
  if (!r.done) {
    return new CliError('the stream ended without [DONE]; the response is incomplete', EXIT.NETWORK, { status: 200, code: 'stream_incomplete' });
  }
  return null;
}
