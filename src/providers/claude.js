// OpenAI Chat Completions <-> Anthropic Messages adapter (DESIGN §5.5). Raw fetch, no SDK.
import { randomUUID } from 'node:crypto';
import { GatewayError } from '../http.js';
import { modelInfo } from '../pricing.js';
import { serializeJson } from '../sse.js';

export const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS_CAP = 32000;
const UNKNOWN_MODEL_MAX_TOKENS = 8192;
const EFFORTS = { none: 'low', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' };
const FINISH = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  pause_turn: 'stop',
  max_tokens: 'length',
  model_context_window_exceeded: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
};
const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/;

/** @param {string} code @param {string} message */
const invalid = (code, message) => new GatewayError(400, code, message);
/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @param {string} key */
export function authHeaders(key) {
  return { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION };
}

/** Model-list request used to verify a key (no token spend). @param {string} baseUrl @param {string} key */
export function verifyRequest(baseUrl, key) {
  return { url: `${baseUrl}/v1/models`, headers: authHeaders(key) };
}

/** Default `max_tokens`: the model's max_output capped at 32000; unknown models 8192. @param {string} model */
export function defaultMaxTokens(model) {
  const max = modelInfo('claude', model)?.max_output;
  return typeof max === 'number' ? Math.min(max, DEFAULT_MAX_TOKENS_CAP) : UNKNOWN_MODEL_MAX_TOKENS;
}

/**
 * Text of a system/developer/tool message: a string or an array of text parts.
 * @param {unknown} content
 * @param {string} role
 * @returns {string[]}
 */
function textParts(content, role) {
  if (typeof content === 'string') return [content];
  if (content === null || content === undefined) return [];
  if (!Array.isArray(content)) throw invalid('invalid_parameter', `${role} message content must be a string or an array of parts.`);
  return content.map((part) => {
    if (isObject(part) && part.type === 'text' && typeof part.text === 'string') return part.text;
    throw invalid('unsupported_content', `${role} messages support only text parts.`);
  });
}

/** @param {unknown} part */
function imageBlock(part) {
  const p = /** @type {Record<string, any>} */ (part);
  const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
  if (typeof url !== 'string') throw invalid('invalid_parameter', 'image_url parts need an image_url.url string.');
  const data = IMAGE_DATA_URL.exec(url);
  if (data) return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2].replace(/\s/g, '') } };
  if (/^https?:\/\//i.test(url)) return { type: 'image', source: { type: 'url', url } };
  throw invalid('unsupported_content', 'image_url must be an http(s) URL or a base64 data URL of a PNG, JPEG, GIF or WebP image.');
}

/** User content -> Messages content blocks. @param {unknown} content */
function userBlocks(content) {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  if (!Array.isArray(content)) throw invalid('invalid_parameter', 'user message content must be a string or an array of parts.');
  return content.map((part) => {
    if (isObject(part) && part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
    if (isObject(part) && part.type === 'image_url') return imageBlock(part);
    const type = isObject(part) && typeof part.type === 'string' ? part.type : typeof part;
    throw invalid('unsupported_content', `Content part type "${String(type).slice(0, 40)}" is not supported for Claude models; use text or image_url.`);
  });
}

/** Assistant message -> text blocks + tool_use blocks. @param {Record<string, any>} m */
function assistantBlocks(m) {
  /** @type {Record<string, unknown>[]} */
  const blocks = [];
  if (typeof m.content === 'string') {
    if (m.content !== '') blocks.push({ type: 'text', text: m.content });
  } else if (Array.isArray(m.content)) {
    for (const part of m.content) {
      const text = isObject(part) && (part.type === 'text' ? part.text : part.type === 'refusal' ? part.refusal : undefined);
      if (typeof text !== 'string') throw invalid('unsupported_content', 'assistant messages support only text parts.');
      if (text !== '') blocks.push({ type: 'text', text });
    }
  } else if (m.content !== null && m.content !== undefined) {
    throw invalid('invalid_parameter', 'assistant message content must be a string, an array of parts or null.');
  }
  if (m.tool_calls !== undefined && m.tool_calls !== null) {
    if (!Array.isArray(m.tool_calls)) throw invalid('invalid_parameter', 'tool_calls must be an array.');
    for (const call of m.tool_calls) {
      const fn = isObject(call) ? call.function : undefined;
      if (!isObject(fn) || typeof fn.name !== 'string' || typeof call.id !== 'string') {
        throw invalid('invalid_parameter', 'Each tool call needs an id and function.name.');
      }
      let input;
      try {
        input = fn.arguments === undefined || fn.arguments === '' ? {} : JSON.parse(fn.arguments);
      } catch {
        input = undefined;
      }
      if (!isObject(input)) {
        throw invalid('invalid_tool_arguments', `Tool call "${call.id.slice(0, 64)}" arguments must be a JSON object string.`);
      }
      blocks.push({ type: 'tool_use', id: call.id, name: fn.name, input });
    }
  }
  return blocks;
}

/**
 * OpenAI messages -> {system, messages}. System/developer messages are hoisted in order; a run of
 * tool messages (plus a directly following user message) becomes one user message with all
 * tool_result blocks first.
 * @param {unknown} messages
 */
function translateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) throw invalid('invalid_parameter', 'messages must be a non-empty array.');
  /** @type {{type: 'text', text: string}[]} */
  const system = [];
  /** @type {{role: 'user' | 'assistant', content: Record<string, unknown>[]}[]} */
  const out = [];
  /** @type {Record<string, unknown>[] | null} */
  let toolResults = null;
  const flushTools = () => {
    if (toolResults) out.push({ role: 'user', content: toolResults });
    toolResults = null;
  };
  for (const m of messages) {
    if (!isObject(m) || typeof m.role !== 'string') throw invalid('invalid_parameter', 'Each message must be an object with a role.');
    if (m.role === 'system' || m.role === 'developer') {
      for (const text of textParts(m.content, m.role)) if (text !== '') system.push({ type: 'text', text });
    } else if (m.role === 'tool') {
      if (typeof m.tool_call_id !== 'string') throw invalid('invalid_parameter', 'tool messages need a tool_call_id.');
      const text = textParts(m.content, 'tool').join('');
      /** @type {Record<string, unknown>} */
      const result = { type: 'tool_result', tool_use_id: m.tool_call_id };
      if (text !== '') result.content = text;
      (toolResults ??= []).push(result);
    } else if (m.role === 'user') {
      const blocks = userBlocks(m.content);
      if (toolResults) {
        toolResults.push(...blocks);
        flushTools();
      } else if (blocks.length) out.push({ role: 'user', content: blocks });
    } else if (m.role === 'assistant') {
      flushTools();
      const blocks = assistantBlocks(m);
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
    } else {
      throw invalid('invalid_parameter', `Unsupported message role "${m.role.slice(0, 40)}".`);
    }
  }
  flushTools();
  if (out.length === 0) throw invalid('invalid_parameter', 'messages must include at least one user or assistant message with content.');
  return { system, messages: out };
}

/** @param {unknown} tools */
function translateTools(tools) {
  if (!Array.isArray(tools)) throw invalid('invalid_parameter', 'tools must be an array.');
  return tools.map((t) => {
    if (!isObject(t) || t.type !== 'function' || !isObject(t.function) || typeof t.function.name !== 'string') {
      throw invalid('unsupported_parameter', 'Only function tools ({"type":"function","function":{"name",...}}) are supported for Claude models.');
    }
    const fn = t.function;
    /** @type {Record<string, unknown>} */
    const tool = { name: fn.name };
    if (typeof fn.description === 'string') tool.description = fn.description;
    tool.input_schema = isObject(fn.parameters) ? fn.parameters : { type: 'object', properties: {} };
    if (typeof fn.strict === 'boolean') tool.strict = fn.strict;
    return tool;
  });
}

/** @param {unknown} choice */
function translateToolChoice(choice) {
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any' };
  if (isObject(choice) && choice.type === 'function' && isObject(choice.function) && typeof choice.function.name === 'string') {
    return { type: 'tool', name: choice.function.name };
  }
  throw invalid('invalid_parameter', 'tool_choice must be "auto", "none", "required" or {"type":"function","function":{"name"}}.');
}

/**
 * Translate an OpenAI Chat Completions body for POST /v1/messages.
 * @param {Record<string, any>} body
 * @param {{model: string, cache: boolean}} options cache=false when the client sent `x-router-cache: off`
 * @returns {{body: Record<string, unknown>, dropped: string[], stream: boolean, includeUsage: boolean}}
 */
export function buildRequest(body, { model, cache }) {
  const info = modelInfo('claude', model);
  /** @type {string[]} */
  const dropped = [];
  if (body.n !== undefined && body.n !== null && body.n !== 1) {
    throw invalid('unsupported_parameter', 'n > 1 is not supported for Claude models.');
  }
  if ((body.audio !== undefined && body.audio !== null) || (Array.isArray(body.modalities) && body.modalities.includes('audio'))) {
    throw invalid('unsupported_parameter', 'Audio input/output is not supported for Claude models.');
  }
  const { system, messages } = translateMessages(body.messages);
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens !== undefined && maxTokens !== null && !(Number.isSafeInteger(maxTokens) && maxTokens > 0)) {
    throw invalid('invalid_parameter', 'max_tokens / max_completion_tokens must be a positive integer.');
  }
  /** @type {Record<string, any>} */
  const out = { model, max_tokens: maxTokens ?? defaultMaxTokens(model), messages };
  if (system.length) out.system = system;

  if (body.stop !== undefined && body.stop !== null) {
    const stops = typeof body.stop === 'string' ? [body.stop] : body.stop;
    if (!Array.isArray(stops) || !stops.every((s) => typeof s === 'string')) {
      throw invalid('invalid_parameter', 'stop must be a string or an array of strings.');
    }
    const kept = stops.filter((s) => s.trim() !== '');
    if (kept.length) out.stop_sequences = kept;
  }
  const stream = body.stream === true;
  if (stream) out.stream = true;

  if (body.tools !== undefined && body.tools !== null) {
    const tools = translateTools(body.tools);
    if (tools.length) out.tools = tools;
  }
  if (body.tool_choice !== undefined && body.tool_choice !== null) out.tool_choice = translateToolChoice(body.tool_choice);
  if (body.parallel_tool_calls === false && (out.tools || out.tool_choice) && out.tool_choice?.type !== 'none') {
    out.tool_choice = { ...(out.tool_choice ?? { type: 'auto' }), disable_parallel_tool_use: true };
  }

  const nativeOutput = Object.hasOwn(body, 'output_config');
  if (nativeOutput && !isObject(body.output_config)) throw invalid('invalid_parameter', 'output_config must be an object.');
  /** @type {Record<string, unknown>} */
  const outputConfig = nativeOutput ? { ...body.output_config } : {};
  const rf = body.response_format;
  if (rf !== undefined && rf !== null) {
    if (!isObject(rf) || typeof rf.type !== 'string') throw invalid('invalid_parameter', 'response_format must be an object with a type.');
    if (rf.type === 'json_object') {
      throw invalid('unsupported_parameter', 'response_format json_object has no faithful equivalent for Claude models; use json_schema.');
    }
    if (rf.type === 'json_schema') {
      if (!isObject(rf.json_schema) || !isObject(rf.json_schema.schema)) {
        throw invalid('invalid_parameter', 'response_format json_schema needs json_schema.schema (an object).');
      }
      outputConfig.format = { type: 'json_schema', schema: rf.json_schema.schema };
    } else if (rf.type !== 'text') {
      throw invalid('invalid_parameter', 'response_format type must be text or json_schema.');
    }
  }
  if (body.reasoning_effort !== undefined && body.reasoning_effort !== null) {
    const effort = Object.hasOwn(EFFORTS, body.reasoning_effort) ? EFFORTS[/** @type {keyof typeof EFFORTS} */ (body.reasoning_effort)] : null;
    if (!effort) throw invalid('invalid_parameter', `reasoning_effort must be one of: ${Object.keys(EFFORTS).join(', ')}.`);
    outputConfig.effort = effort;
  } else if (info?.reasoning_effort !== false && !Object.hasOwn(body, 'reasoning_effort') && !nativeOutput && !Object.hasOwn(body.anthropic ?? {}, 'output_config')) {
    outputConfig.effort = 'medium';
  }
  if (nativeOutput || Object.keys(outputConfig).length) out.output_config = outputConfig;

  for (const name of /** @type {const} */ (['temperature', 'top_p'])) {
    const v = body[name];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid('invalid_parameter', `${name} must be a number.`);
    // Claude models reject temperature and top_p in one request: temperature wins.
    if (info?.sampling === false || (name === 'top_p' && 'temperature' in out)) dropped.push(name);
    else out[name] = name === 'temperature' ? Math.min(v, 1) : v;
  }

  const extra = body.anthropic;
  if (extra !== undefined && extra !== null && !isObject(extra)) {
    throw invalid('invalid_parameter', 'anthropic must be an object (it is merged into the Messages request).');
  }
  if (cache && !(isObject(extra) && Object.hasOwn(extra, 'cache_control'))) out.cache_control = { type: 'ephemeral' };
  if (isObject(extra)) {
    // `model` and `stream` stay the gateway's: routing, usage and response parsing depend on them.
    const { model: _model, stream: _stream, ...rest } = extra;
    Object.assign(out, rest);
  }
  if (out.cache_control === null) delete out.cache_control;

  return { body: out, dropped, stream, includeUsage: body.stream_options?.include_usage === true };
}

/**
 * Messages `usage` -> normalized usage (prompt includes cache reads and writes).
 * @param {unknown} u
 * @returns {import('../pricing.js').Usage | null}
 */
export function usageFromMessages(u) {
  if (!isObject(u)) return null;
  const n = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const input = n(u.input_tokens);
  const read = n(u.cache_read_input_tokens);
  const write = n(u.cache_creation_input_tokens);
  return { prompt_tokens: input + read + write, completion_tokens: n(u.output_tokens), cached_tokens: read, cache_write_tokens: write, reasoning_tokens: 0 };
}

/** Normalized usage -> OpenAI `usage`. @param {import('../pricing.js').Usage} u */
function openAIUsage(u) {
  return {
    prompt_tokens: u.prompt_tokens,
    completion_tokens: u.completion_tokens,
    total_tokens: u.prompt_tokens + u.completion_tokens,
    prompt_tokens_details: { cached_tokens: u.cached_tokens, cache_write_tokens: u.cache_write_tokens },
  };
}

/** @param {unknown} reason */
const finishReason = (reason) => (typeof reason === 'string' && Object.hasOwn(FINISH, reason) ? FINISH[/** @type {keyof typeof FINISH} */ (reason)] : 'stop');

/**
 * Non-streaming Messages response -> chat.completion.
 * @param {Record<string, any>} msg
 * @param {{model: string, created: number}} options
 */
export function translateResponse(msg, { model, created }) {
  let text = '';
  let reasoning = '';
  /** @type {Record<string, unknown>[]} */
  const toolCalls = [];
  for (const block of Array.isArray(msg.content) ? msg.content : []) {
    if (!isObject(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } });
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') reasoning += block.thinking;
  }
  /** @type {Record<string, unknown>} */
  const message = { role: 'assistant', content: text === '' && toolCalls.length ? null : text };
  if (reasoning !== '') message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  const usage = usageFromMessages(msg.usage);
  /** @type {Record<string, unknown>} */
  const out = {
    id: typeof msg.id === 'string' ? msg.id : `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: finishReason(msg.stop_reason) }],
  };
  if (usage) out.usage = openAIUsage(usage);
  return { body: out, usage };
}

/**
 * One step of a stream tap: text to relay, the end of the stream, or an in-stream upstream error
 * (the provider's raw error object; the proxy normalizes and scrubs it).
 * @typedef {{out?: string, done?: boolean, error?: Record<string, any>}} StreamStep
 */

/**
 * Streaming translator: one Messages SSE event in, zero or more chat.completion.chunk events out.
 * @param {{model: string, created: number, includeUsage: boolean}} options
 */
export function createStreamTranslator({ model, created, includeUsage }) {
  let id = `chatcmpl-${randomUUID()}`;
  /** @type {Record<string, any>} */
  let rawUsage = {};
  let usageFinal = false;
  /** @type {Map<number, {index: number, hasArguments: boolean}>} content block index -> tool call */
  const tools = new Map();

  const usage = () => (Object.keys(rawUsage).length ? usageFromMessages(rawUsage) : null);
  /** @param {Record<string, unknown>} delta @param {string | null} [finish] */
  const chunk = (delta, finish = null) =>
    serializeJson({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] });

  return {
    get usage() {
      return usage();
    },
    get usageFinal() {
      return usageFinal;
    },
    /**
     * @param {import('../sse.js').SSEItem} item
     * @returns {StreamStep}
     */
    onItem(item) {
      if (!('data' in item)) return {}; // comments are not part of the Messages protocol
      let e;
      try {
        e = JSON.parse(item.data);
      } catch {
        return {};
      }
      if (!isObject(e)) return {};
      switch (e.type) {
        case 'message_start': {
          if (typeof e.message?.id === 'string') id = e.message.id;
          if (isObject(e.message?.usage)) rawUsage = { ...e.message.usage };
          return { out: chunk({ role: 'assistant', content: '' }) };
        }
        case 'content_block_start': {
          const block = e.content_block;
          if (!isObject(block)) return {};
          if (block.type === 'tool_use') {
            const index = tools.size;
            tools.set(e.index, { index, hasArguments: false });
            return { out: chunk({ tool_calls: [{ index, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }] }) };
          }
          if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') return { out: chunk({ content: block.text }) };
          if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking !== '') {
            return { out: chunk({ reasoning_content: block.thinking }) };
          }
          return {};
        }
        case 'content_block_delta': {
          const d = e.delta;
          if (!isObject(d)) return {};
          if (d.type === 'text_delta' && typeof d.text === 'string' && d.text !== '') return { out: chunk({ content: d.text }) };
          const tool = tools.get(e.index);
          if (d.type === 'input_json_delta' && typeof d.partial_json === 'string' && d.partial_json !== '' && tool) {
            tool.hasArguments = true;
            return { out: chunk({ tool_calls: [{ index: tool.index, function: { arguments: d.partial_json } }] }) };
          }
          if (d.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking !== '') {
            return { out: chunk({ reasoning_content: d.thinking }) };
          }
          return {}; // signature_delta, citations, empty fragments
        }
        case 'content_block_stop': {
          // A tool call without input fragments has input {}: give clients parseable arguments.
          const tool = tools.get(e.index);
          if (!tool || tool.hasArguments) return {};
          tool.hasArguments = true;
          return { out: chunk({ tool_calls: [{ index: tool.index, function: { arguments: '{}' } }] }) };
        }
        case 'message_delta': {
          if (isObject(e.usage)) {
            // Cumulative counts; only numbers replace message_start's (input/cache fields may be null).
            for (const [k, v] of Object.entries(e.usage)) if (typeof v === 'number') rawUsage[k] = v;
            usageFinal = true;
          }
          return { out: chunk({}, finishReason(e.delta?.stop_reason)) };
        }
        case 'message_stop': {
          const u = usage();
          const out = includeUsage && u ? serializeJson({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: openAIUsage(u) }) : '';
          return { out, done: true };
        }
        case 'error':
          return { error: isObject(e.error) ? e.error : {} };
        default:
          return {}; // ping, unknown events
      }
    },
  };
}
