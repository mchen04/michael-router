#!/usr/bin/env node
// Fake Claude (Messages API), Gemini (OpenAI-compatible) and OpenRouter servers in one process
// (mocked evidence, for tests and benchmarks only).
//   node dev/fake-providers.js [--port 0] [--host 127.0.0.1] [--scenario ok] [--latency-ms 0]
//
// One port with a path prefix per provider; point the router at
//   ANTHROPIC_BASE_URL=<url>/claude  GEMINI_BASE_URL=<url>/gemini  OPENROUTER_BASE_URL=<url>/openrouter
//
// Scenario selection: a model name ending in `fake-<scenario>` (claude-fake-429,
// gemini-fake-midstream-error, vendor/fake-truncated), otherwise the default scenario:
//   ok, ok-tools, no-usage, 400|401|402|403|404|429|500|503|529 (any 4xx/5xx), 200-error,
//   midstream-error, midstream-error-done, truncated, slow-first-byte, slow-stream, echo-auth,
//   invalid-key, expired-key (Gemini's expired-key 400; the others answer as for invalid-key),
//   hidden-thoughts (Gemini/OpenRouter usage whose total_tokens includes 200 thinking tokens that
//   completion_tokens leaves out)
// Any key is accepted except one containing "revoked" (treated as an invalid key). Key
// verification (the model-list/key endpoints) also answers a default 4xx/5xx scenario.
// Test-only routes: GET /__requests (recorded requests: provider, method, path, headers, raw body,
// parsed body, aborted, completed), DELETE /__requests, POST /__admin {"scenario"?, "latency_ms"?}.
// Nothing is logged.
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const MAX_BODY = 8 * 1024 * 1024;
const SLOW_STEP_MS = 200;
const SLOW_FIRST_BYTE_MS = 2000;
const CREATED = 1760000000;
export const FAKE_USAGE = Object.freeze({
  claude: Object.freeze({ input_tokens: 100, cache_creation_input_tokens: 400, cache_read_input_tokens: 2000, output_tokens: 50 }),
  gemini: Object.freeze({ prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 200 } }),
  openrouter: Object.freeze({
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_tokens: 1200,
    cost: 0.00123,
    cost_details: { upstream_inference_cost: 0.00123 },
    prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 30 },
  }),
});
export const FAKE_TEXT = Object.freeze({
  claude: ['Hello', ' from the fake', ' Claude API.'],
  gemini: ['Hello', ' from the fake', ' Gemini API.'],
  openrouter: ['Hello', ' from the fake', ' OpenRouter API.'],
});
const CLAUDE_ERROR_TYPES = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  402: 'billing_error',
  403: 'permission_error',
  404: 'not_found_error',
  413: 'request_too_large',
  429: 'rate_limit_error',
  500: 'api_error',
  504: 'timeout_error',
  529: 'overloaded_error',
};
const GOOGLE_STATUS = { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 429: 'RESOURCE_EXHAUSTED', 503: 'UNAVAILABLE' };
const GEMINI_KEY_INVALID = 'API key not valid. Please pass a valid API key.';
const GEMINI_KEY_EXPIRED = 'API key expired. Please renew the API key.';
const GEMINI_KEY_DETAILS = [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }];
const HIDDEN_THOUGHT_TOKENS = 200;

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {unknown} model @returns {string | null} */
export function scenarioOf(model) {
  const m = typeof model === 'string' ? /(?:^|[-/])fake-([a-z0-9-]+)$/.exec(model) : null;
  return m ? m[1] : null;
}

/** @typedef {{status: number, headers?: Record<string, string>, frames: string[], stepMs?: number, firstByteMs?: number}} Reply */

/** @param {number} status @param {unknown} body @param {Record<string, string>} [headers] @returns {Reply} */
const json = (status, body, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, frames: [JSON.stringify(body)] });

// ---------------------------------------------------------------- Claude (Messages API)

/** @param {number} status @param {string} message */
function claudeError(status, message) {
  const type = CLAUDE_ERROR_TYPES[/** @type {keyof typeof CLAUDE_ERROR_TYPES} */ (status)] ?? 'api_error';
  return json(status, { type: 'error', error: { type, message }, request_id: 'req_fake_01' }, status === 429 ? { 'retry-after': '7' } : {});
}

/** @param {string} type @param {unknown} data */
const claudeEvent = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * @param {string} scenario @param {Record<string, any>} body @param {string} key
 * @returns {Reply}
 */
function claudeMessages(scenario, body, key) {
  const model = body.model;
  const noUsage = scenario === 'no-usage';
  const tools = scenario === 'ok-tools';
  const text = FAKE_TEXT.claude;
  if (!body.stream) {
    if (scenario === 'echo-auth') return claudeError(400, `invalid request for key ${key}`);
    /** @type {unknown[]} */
    const content = [{ type: 'thinking', thinking: '', signature: 'sig_fake' }, { type: 'text', text: text.join('') }];
    if (tools) {
      content.push(
        { type: 'tool_use', id: 'toolu_fake_1', name: 'get_weather', input: { city: 'Paris' } },
        { type: 'tool_use', id: 'toolu_fake_2', name: 'get_time', input: { tz: 'CET' } },
      );
    }
    return json(200, {
      id: 'msg_fake_01',
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: tools ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      ...(noUsage ? {} : { usage: FAKE_USAGE.claude }),
    });
  }
  const start = claudeEvent('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_fake_01',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      ...(noUsage ? {} : { usage: { ...FAKE_USAGE.claude, output_tokens: 1 } }),
    },
  });
  const thinking = [
    claudeEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
    claudeEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_fake' } }),
    claudeEvent('content_block_stop', { type: 'content_block_stop', index: 0 }),
  ];
  const textBlock = [
    claudeEvent('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    ...text.map((t) => claudeEvent('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: t } })),
    claudeEvent('content_block_stop', { type: 'content_block_stop', index: 1 }),
  ];
  /** @param {number} index @param {string} id @param {string} name @param {string[]} fragments */
  const toolBlock = (index, id, name, fragments) => [
    claudeEvent('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } }),
    ...fragments.map((f) => claudeEvent('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: f } })),
    claudeEvent('content_block_stop', { type: 'content_block_stop', index }),
  ];
  const end = [
    claudeEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: tools ? 'tool_use' : 'end_turn', stop_sequence: null },
      ...(noUsage ? {} : { usage: { output_tokens: FAKE_USAGE.claude.output_tokens } }),
    }),
    claudeEvent('message_stop', { type: 'message_stop' }),
  ];
  const sse = { 'content-type': 'text/event-stream; charset=utf-8' };
  const midError = (/** @type {string} */ message) => claudeEvent('error', { type: 'error', error: { type: 'overloaded_error', message } });
  switch (scenario) {
    case 'midstream-error':
      return { status: 200, headers: sse, frames: [start, ...textBlock.slice(0, 2), midError('Overloaded')] };
    case 'midstream-error-done':
      return { status: 200, headers: sse, frames: [start, ...textBlock.slice(0, 2), midError('Overloaded'), 'data: [DONE]\n\n'] };
    case 'echo-auth':
      return { status: 200, headers: sse, frames: [start, midError(`stream failed for key ${key}`)] };
    case 'truncated':
      return { status: 200, headers: sse, frames: [start, ...textBlock.slice(0, 2)] };
    case 'slow-stream':
      return { status: 200, headers: sse, frames: [start, ...textBlock, ...end], stepMs: SLOW_STEP_MS };
    default:
      return {
        status: 200,
        headers: sse,
        frames: [
          start,
          ...thinking,
          claudeEvent('ping', { type: 'ping' }),
          ...textBlock,
          ...(tools ? [...toolBlock(2, 'toolu_fake_1', 'get_weather', ['{"ci', 'ty": "Par', 'is"}']), ...toolBlock(3, 'toolu_fake_2', 'get_time', ['{"tz":', ' "CET"}'])] : []),
          ...end,
        ],
      };
  }
}

// ---------------------------------------------------------------- OpenAI-shaped (Gemini, OpenRouter)

/**
 * @param {'gemini' | 'openrouter'} provider @param {number} status @param {string} message @param {boolean} [arrayWrapped]
 */
function openAIError(provider, status, message, arrayWrapped = false, details = undefined) {
  const headers = status === 429 ? { 'retry-after': '7' } : {};
  if (provider === 'openrouter') return json(status, { error: { code: status, message, metadata: { provider_name: 'Fake' } } }, headers);
  /** @type {Record<string, unknown>} */
  const error = { code: status, message, status: GOOGLE_STATUS[/** @type {keyof typeof GOOGLE_STATUS} */ (status)] ?? 'INTERNAL' };
  if (details) error.details = details;
  return json(status, arrayWrapped ? [{ error }] : { error }, headers);
}

/**
 * @param {'gemini' | 'openrouter'} provider @param {string} scenario @param {Record<string, any>} body @param {string} key
 * @returns {Reply}
 */
function chatCompletions(provider, scenario, body, key) {
  const model = body.model;
  const base = FAKE_USAGE[provider];
  const usage =
    scenario === 'no-usage' ? undefined : scenario === 'hidden-thoughts' ? { ...base, total_tokens: base.total_tokens + HIDDEN_THOUGHT_TOKENS } : base;
  const tools = scenario === 'ok-tools';
  const text = FAKE_TEXT[provider];
  if (scenario === '200-error') return json(200, { error: { code: 502, message: 'Provider returned error', metadata: { provider_name: 'Fake' } } });
  if (!body.stream) {
    if (scenario === 'echo-auth') return openAIError(provider, 400, `invalid request for key ${key}`);
    /** @type {Record<string, unknown>} */
    const message = { role: 'assistant', content: text.join('') };
    if (tools) message.tool_calls = [{ id: 'call_fake_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }];
    const out = {
      id: 'chatcmpl-fake-1',
      object: 'chat.completion',
      created: CREATED,
      model,
      ...(provider === 'openrouter' ? { provider: 'Fake' } : {}),
      choices: [{ index: 0, message, finish_reason: tools ? 'tool_calls' : 'stop' }],
      ...(usage ? { usage } : {}),
    };
    // OpenRouter may send whitespace before the JSON body while it waits for the provider.
    const reply = json(200, out);
    if (provider === 'openrouter') reply.frames = [`\n${reply.frames[0]}`];
    return reply;
  }
  const eol = provider === 'gemini' ? '\r\n' : '\n';
  /** @param {unknown} data */
  const frame = (data) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}${eol}${eol}`;
  /** @param {Record<string, unknown>} delta @param {string | null} [finish] @param {Record<string, unknown>} [extra] */
  const chunk = (delta, finish = null, extra = {}) =>
    frame({ id: 'chatcmpl-fake-1', object: 'chat.completion.chunk', created: CREATED, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
  const head = provider === 'openrouter' ? [`: OPENROUTER PROCESSING${eol}${eol}`] : [];
  const role = chunk({ role: 'assistant', content: '' });
  const content = text.map((t) => chunk({ content: t }));
  const toolFrames = tools
    ? [
        chunk({ tool_calls: [{ index: 0, id: 'call_fake_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }),
      ]
    : [];
  const finish = tools ? 'tool_calls' : 'stop';
  /** @type {string[]} */
  let tail;
  if (provider === 'openrouter') {
    // The final chunk repeats finish_reason with an empty delta and carries usage.
    tail = [chunk({}, finish), ...(usage ? [chunk({ role: 'assistant', content: '' }, finish, { usage })] : []), frame('[DONE]')];
  } else {
    const askedUsage = body.stream_options?.include_usage === true;
    tail = [
      chunk({}, finish),
      ...(usage && askedUsage ? [frame({ id: 'chatcmpl-fake-1', object: 'chat.completion.chunk', created: CREATED, model, choices: [], usage })] : []),
      frame('[DONE]'),
    ];
  }
  const midError = (/** @type {string} */ message) =>
    provider === 'openrouter'
      ? frame({ id: 'chatcmpl-fake-1', object: 'chat.completion.chunk', created: CREATED, model, error: { code: 502, message }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] })
      : frame({ error: { code: 500, message, status: 'INTERNAL' } });
  const sse = { 'content-type': 'text/event-stream; charset=utf-8' };
  switch (scenario) {
    case 'midstream-error':
      return { status: 200, headers: sse, frames: [...head, role, content[0], midError('Upstream provider error')] };
    case 'midstream-error-done':
      return { status: 200, headers: sse, frames: [...head, role, content[0], midError('Upstream provider error'), frame('[DONE]')] };
    case 'echo-auth':
      return { status: 200, headers: sse, frames: [...head, role, midError(`stream failed for key ${key}`)] };
    case 'truncated':
      return { status: 200, headers: sse, frames: [...head, role, content[0]] };
    case 'slow-stream':
      return { status: 200, headers: sse, frames: [...head, role, ...content, ...tail], stepMs: SLOW_STEP_MS };
    default:
      return { status: 200, headers: sse, frames: [...head, role, ...content, ...toolFrames, ...tail] };
  }
}

// ---------------------------------------------------------------- routing

/**
 * @param {string} provider @param {string} method @param {string} path @param {Record<string, any>} headers
 * @param {Record<string, any> | null} body @param {{scenario: string}} defaults
 * @returns {Reply}
 */
function reply(provider, method, path, headers, body, defaults) {
  const bearer = /^Bearer (.+)$/.exec(String(headers.authorization ?? ''))?.[1] ?? '';
  const key = provider === 'claude' ? String(headers['x-api-key'] ?? '') : bearer;
  const keyBad = key === '' || key.includes('revoked');
  const invalidKey = () =>
    provider === 'claude'
      ? claudeError(401, 'invalid x-api-key')
      : provider === 'gemini'
        ? openAIError('gemini', 400, GEMINI_KEY_INVALID, true, GEMINI_KEY_DETAILS)
        : openAIError('openrouter', 401, 'No auth credentials found');
  if (provider === 'claude' && !headers['anthropic-version']) return claudeError(400, 'anthropic-version: header is required');

  const listPath = { claude: '/v1/models', gemini: '/v1beta/openai/models', openrouter: '/api/v1/key' }[provider];
  const chatPath = { claude: '/v1/messages', gemini: '/v1beta/openai/chat/completions', openrouter: '/api/v1/chat/completions' }[provider];
  if (method === 'GET' && path === listPath) {
    if (keyBad) return invalidKey();
    if (/^[45]\d\d$/.test(defaults.scenario)) {
      const status = Number(defaults.scenario); // a default error scenario also answers key verification
      return provider === 'claude' ? claudeError(status, `fake ${status} error`) : openAIError(/** @type {any} */ (provider), status, `fake ${status} error`);
    }
    if (provider === 'claude') {
      const m = { id: 'claude-haiku-5-5', type: 'model', display_name: 'Claude Haiku 5.5', created_at: '2026-01-01T00:00:00Z' };
      return json(200, { data: [m], has_more: false, first_id: m.id, last_id: m.id });
    }
    if (provider === 'gemini') return json(200, { object: 'list', data: [{ id: 'models/gemini-2.5-flash', object: 'model', owned_by: 'google' }] });
    return json(200, { data: { label: 'fake', limit: null, usage: 0, is_free_tier: false } });
  }
  if (path !== chatPath) return json(404, { error: { message: 'not found' } });
  if (method !== 'POST') return json(405, { error: { message: 'method not allowed' } });
  if (!body || typeof body !== 'object') {
    return provider === 'claude' ? claudeError(400, 'invalid JSON body') : openAIError(/** @type {any} */ (provider), 400, 'invalid JSON body');
  }
  const scenario = scenarioOf(body.model) ?? defaults.scenario;
  if (keyBad || scenario === 'invalid-key') return invalidKey();
  if (scenario === 'expired-key') return provider === 'gemini' ? openAIError('gemini', 400, GEMINI_KEY_EXPIRED, true, GEMINI_KEY_DETAILS) : invalidKey();
  if (/^[45]\d\d$/.test(scenario)) {
    const status = Number(scenario);
    return provider === 'claude' ? claudeError(status, `fake ${status} error`) : openAIError(/** @type {any} */ (provider), status, `fake ${status} error`);
  }
  const known = ['ok', 'ok-tools', 'no-usage', 'hidden-thoughts', '200-error', 'midstream-error', 'midstream-error-done', 'truncated', 'slow-first-byte', 'slow-stream', 'echo-auth'];
  if (!known.includes(scenario)) return json(400, { error: { message: `unknown fake scenario "${scenario}"` } });
  const r = provider === 'claude' ? claudeMessages(scenario, body, key) : chatCompletions(/** @type {any} */ (provider), scenario, body, key);
  if (scenario === 'slow-first-byte') r.firstByteMs = SLOW_FIRST_BYTE_MS;
  return r;
}

/**
 * @param {{port?: number, host?: string, scenario?: string, latencyMs?: number}} [options]
 */
export async function startFakeProviders({ port = 0, host = '127.0.0.1', scenario = 'ok', latencyMs = 0 } = {}) {
  const defaults = { scenario, latencyMs };
  /** @type {{id: number, provider: string, method: string, path: string, headers: Record<string, any>, raw: string, body: any, aborted: boolean, completed: boolean}[]} */
  const requests = [];
  let nextId = 1;

  /** @param {http.ServerResponse} res @param {number} status @param {unknown} body */
  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) return sendJson(res, 413, { error: { message: 'request too large' } });
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');

    if (url.pathname === '/__requests') {
      if (req.method === 'DELETE') {
        requests.length = 0;
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 200, requests);
    }
    if (url.pathname === '/__admin' && req.method === 'POST') {
      try {
        const o = JSON.parse(raw);
        if (typeof o.scenario === 'string') defaults.scenario = o.scenario;
        if (Number.isInteger(o.latency_ms) && o.latency_ms >= 0) defaults.latencyMs = o.latency_ms;
        return sendJson(res, 200, { scenario: defaults.scenario, latency_ms: defaults.latencyMs });
      } catch {
        return sendJson(res, 400, { error: { message: 'invalid JSON' } });
      }
    }
    const m = /^\/(claude|gemini|openrouter)(\/.*)$/.exec(url.pathname);
    if (!m) return sendJson(res, 404, { error: { message: 'not found' } });
    const [, provider, path] = m;
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    const record = { id: nextId++, provider, method: String(req.method), path, headers: { ...req.headers }, raw, body, aborted: false, completed: false };
    requests.push(record);
    res.on('close', () => {
      if (!res.writableFinished) record.aborted = true;
    });

    const r = reply(provider, String(req.method), path, req.headers, body, defaults);
    const firstByteMs = r.firstByteMs ?? defaults.latencyMs;
    if (firstByteMs > 0) await sleep(firstByteMs);
    if (res.destroyed) return;
    res.writeHead(r.status, r.headers ?? {});
    for (let i = 0; i < r.frames.length; i++) {
      if (res.destroyed) return;
      if (i > 0 && r.stepMs) await sleep(r.stepMs);
      if (res.destroyed) return;
      res.write(r.frames[i]);
    }
    res.end(() => {
      record.completed = true;
    });
  });

  await new Promise((resolve) => server.listen(port, host, () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  const url = `http://${address.address}:${address.port}`;
  return {
    url,
    port: address.port,
    baseUrls: { claude: `${url}/claude`, gemini: `${url}/gemini`, openrouter: `${url}/openrouter` },
    /** Router env pointing every provider at this fake. */
    env: { ANTHROPIC_BASE_URL: `${url}/claude`, GEMINI_BASE_URL: `${url}/gemini`, OPENROUTER_BASE_URL: `${url}/openrouter` },
    requests,
    /** @param {{scenario?: string, latencyMs?: number}} d */
    setDefaults(d) {
      if (d.scenario !== undefined) defaults.scenario = d.scenario;
      if (d.latencyMs !== undefined) defaults.latencyMs = d.latencyMs;
    },
    reset() {
      requests.length = 0;
      defaults.scenario = scenario;
      defaults.latencyMs = latencyMs;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve(undefined));
        server.closeAllConnections();
      }),
  };
}

/** @param {string[]} argv */
function parseFlags(argv) {
  /** @type {{port?: number, host?: string, scenario?: string, latencyMs?: number}} */
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = () => inline ?? argv[++i];
    if (flag === '--port') opts.port = Number(value());
    else if (flag === '--host') opts.host = value();
    else if (flag === '--scenario') opts.scenario = value();
    else if (flag === '--latency-ms') opts.latencyMs = Number(value());
    else throw new Error(`unknown argument: ${flag}`);
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const fake = await startFakeProviders(parseFlags(process.argv.slice(2)));
    console.log(`listening on ${fake.url}`);
    const stop = async () => {
      await fake.close();
      process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } catch (err) {
    console.error(`fake-providers failed: ${/** @type {Error} */ (err).message}`);
    process.exit(1);
  }
}
