// Claude adapter (DESIGN §5.5): request translation rows, response translation, streaming translation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GatewayError } from '../../src/http.js';
import { buildRequest, createStreamTranslator, defaultMaxTokens, translateResponse } from '../../src/providers/claude.js';
import { createSSEParser } from '../../src/sse.js';

const SAMPLING_OFF = 'claude-haiku-5-5'; // sampling: false in pricing.json
const SAMPLING_ON = 'claude-haiku-4-5'; // sampling: true
const user = (/** @type {unknown} */ content) => ({ role: 'user', content });
/** @param {Record<string, unknown>} extra @param {string} [model] @param {boolean} [cache] */
const build = (extra, model = SAMPLING_OFF, cache = true) => buildRequest({ model, messages: [user('hi')], ...extra }, { model, cache });
/** @param {Record<string, unknown>} body @param {string} code */
function rejects(body, code) {
  assert.throws(
    () => buildRequest({ model: SAMPLING_OFF, messages: [user('hi')], ...body }, { model: SAMPLING_OFF, cache: true }),
    (/** @type {any} */ e) => e instanceof GatewayError && e.status === 400 && e.code === code,
    JSON.stringify(body),
  );
}

test('system and developer messages anywhere are hoisted, in order, into top-level system text blocks', () => {
  const { body } = buildRequest(
    {
      messages: [
        { role: 'system', content: 'S1' },
        user('U1'),
        { role: 'developer', content: [{ type: 'text', text: 'D1' }, { type: 'text', text: 'D2' }] },
        { role: 'assistant', content: 'A1' },
        { role: 'system', content: '' },
        user('U2'),
      ],
    },
    { model: SAMPLING_OFF, cache: true },
  );
  assert.deepEqual(body.system, [
    { type: 'text', text: 'S1' },
    { type: 'text', text: 'D1' },
    { type: 'text', text: 'D2' },
  ]);
  assert.deepEqual(body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'U1' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'A1' }] },
    { role: 'user', content: [{ type: 'text', text: 'U2' }] },
  ]);
  rejects({ messages: [{ role: 'system', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] }, user('x')] }, 'unsupported_content');
});

test('user content: text parts, base64 data-URL images, http(s) URL images; other parts are 400 unsupported_content', () => {
  const { body } = build({
    messages: [
      user([
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
        { type: 'image_url', image_url: { url: 'https://example.com/cat.jpg', detail: 'high' } },
      ]),
    ],
  });
  assert.deepEqual(body.messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
        { type: 'image', source: { type: 'url', url: 'https://example.com/cat.jpg' } },
      ],
    },
  ]);
  for (const part of [
    { type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } },
    { type: 'file', file: { file_id: 'f1' } },
    { type: 'image_url', image_url: { url: 'data:application/pdf;base64,JVBERi0=' } },
    { type: 'image_url', image_url: { url: 'ftp://example.com/x.png' } },
  ]) {
    rejects({ messages: [user([part])] }, 'unsupported_content');
  }
});

test('assistant content + tool_calls -> text and tool_use blocks; arguments must be a JSON object string', () => {
  const { body } = build({
    messages: [
      user('weather?'),
      {
        role: 'assistant',
        content: 'Checking.',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
          { id: 'call_2', type: 'function', function: { name: 'get_time', arguments: '' } },
        ],
      },
    ],
  });
  assert.deepEqual(body.messages[1], {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
      { type: 'tool_use', id: 'call_2', name: 'get_time', input: {} },
    ],
  });
  for (const args of ['{"city":', '[1,2]', '"text"', 'null']) {
    rejects({ messages: [user('x'), { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: args } }] }] }, 'invalid_tool_arguments');
  }
});

test('consecutive tool messages (+ a following user message) become one user message, tool_result blocks first', () => {
  const { body } = build({
    messages: [
      user('both'),
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'call_2', type: 'function', function: { name: 'b', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'result one' },
      { role: 'tool', tool_call_id: 'call_2', content: [{ type: 'text', text: 'result ' }, { type: 'text', text: 'two' }] },
      user('thanks, and now?'),
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_3', type: 'function', function: { name: 'c', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_3', content: '' },
    ],
  });
  assert.deepEqual(body.messages.slice(2), [
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'result one' },
        { type: 'tool_result', tool_use_id: 'call_2', content: 'result two' },
        { type: 'text', text: 'thanks, and now?' },
      ],
    },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_3', name: 'c', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_3' }] },
  ]);
  assert.deepEqual(body.messages[1].content.map((/** @type {any} */ b) => b.type), ['tool_use', 'tool_use'], 'content null + tools: no empty text block');
});

test('max_tokens / max_completion_tokens; default = table max_output capped at 32000, unknown models 8192', () => {
  assert.equal(build({}).body.max_tokens, 32000);
  assert.equal(defaultMaxTokens(SAMPLING_ON), 32000);
  assert.equal(defaultMaxTokens('claude-not-in-table'), 8192);
  assert.equal(build({ max_tokens: 100 }).body.max_tokens, 100);
  assert.equal(build({ max_tokens: 100, max_completion_tokens: 200 }).body.max_tokens, 200);
  for (const v of [0, -1, 1.5, '10', true]) rejects({ max_tokens: v }, 'invalid_parameter');
});

test('stop -> stop_sequences without whitespace-only entries; stream -> stream', () => {
  assert.deepEqual(build({ stop: ['END', ' ', '\n', 'STOP'] }).body.stop_sequences, ['END', 'STOP']);
  assert.deepEqual(build({ stop: 'END' }).body.stop_sequences, ['END']);
  assert.ok(!('stop_sequences' in build({ stop: [' \n'] }).body));
  rejects({ stop: [1] }, 'invalid_parameter');
  const streaming = build({ stream: true, stream_options: { include_usage: true } });
  assert.equal(streaming.body.stream, true);
  assert.deepEqual([streaming.stream, streaming.includeUsage], [true, true]);
  assert.deepEqual([build({}).stream, 'stream' in build({}).body], [false, false]);
});

test('tools -> {name, description, input_schema (default empty object schema), strict}; tool_choice and parallel_tool_calls', () => {
  const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
  const { body } = build({
    tools: [
      { type: 'function', function: { name: 'get_weather', description: 'Weather', parameters: schema, strict: true } },
      { type: 'function', function: { name: 'ping' } },
    ],
  });
  assert.deepEqual(body.tools, [
    { name: 'get_weather', description: 'Weather', input_schema: schema, strict: true },
    { name: 'ping', input_schema: { type: 'object', properties: {} } },
  ]);
  rejects({ tools: [{ type: 'custom', custom: { name: 'x' } }] }, 'unsupported_parameter');
  const tools = [{ type: 'function', function: { name: 'f' } }];
  const choice = (/** @type {unknown} */ tool_choice, extra = {}) => build({ tools, tool_choice, ...extra }).body.tool_choice;
  assert.deepEqual(choice('auto'), { type: 'auto' });
  assert.deepEqual(choice('none'), { type: 'none' });
  assert.deepEqual(choice('required'), { type: 'any' });
  assert.deepEqual(choice({ type: 'function', function: { name: 'f' } }), { type: 'tool', name: 'f' });
  rejects({ tools, tool_choice: 'sometimes' }, 'invalid_parameter');
  assert.deepEqual(choice(undefined, { parallel_tool_calls: false }), { type: 'auto', disable_parallel_tool_use: true });
  assert.deepEqual(choice('required', { parallel_tool_calls: false }), { type: 'any', disable_parallel_tool_use: true });
  assert.deepEqual(choice('none', { parallel_tool_calls: false }), { type: 'none' });
  assert.ok(!('tool_choice' in build({ parallel_tool_calls: false }).body), 'no tools: nothing to disable');
});

test('response_format json_schema -> output_config.format; json_object is 400; reasoning_effort -> output_config.effort', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } } };
  assert.deepEqual(build({ response_format: { type: 'json_schema', json_schema: { name: 'x', schema, strict: true } } }).body.output_config, {
    format: { type: 'json_schema', schema },
  });
  rejects({ response_format: { type: 'json_object' } }, 'unsupported_parameter');
  assert.throws(() => build({ response_format: { type: 'json_object' } }), /use json_schema/);
  assert.ok(!('output_config' in build({ response_format: { type: 'text' } }).body));
  const effort = (/** @type {string} */ e) => build({ reasoning_effort: e }).body.output_config.effort;
  assert.deepEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(effort), ['low', 'low', 'low', 'medium', 'high', 'xhigh', 'max']);
  rejects({ reasoning_effort: 'extreme' }, 'invalid_parameter');
  assert.deepEqual(build({ reasoning_effort: 'high', response_format: { type: 'json_schema', json_schema: { schema } } }).body.output_config, {
    format: { type: 'json_schema', schema },
    effort: 'high',
  });
});

test('temperature/top_p: forwarded (temperature <= 1); with both, top_p is dropped (Claude rejects the pair); sampling:false models drop both; drops are named', () => {
  /** @type {[Record<string, unknown>, string, Record<string, unknown>, string[]][]} params, model, forwarded, dropped */
  const cases = [
    [{ temperature: 1.7 }, SAMPLING_ON, { temperature: 1 }, []],
    [{ top_p: 0.9 }, SAMPLING_ON, { top_p: 0.9 }, []],
    [{ temperature: 0.4, top_p: 0.9 }, SAMPLING_ON, { temperature: 0.4 }, ['top_p']],
    [{ temperature: 0.3 }, 'claude-not-in-table', { temperature: 0.3 }, []], // unknown models are passed through honestly
    [{ temperature: 0.4, top_p: 0.9 }, 'claude-not-in-table', { temperature: 0.4 }, ['top_p']],
    [{ temperature: 0.2, top_p: 0.9 }, SAMPLING_OFF, {}, ['temperature', 'top_p']],
  ];
  for (const [params, model, forwarded, dropped] of cases) {
    const { body, dropped: named } = build(params, model);
    const sent = Object.fromEntries(['temperature', 'top_p'].filter((k) => k in body).map((k) => [k, body[k]]));
    assert.deepEqual([sent, named], [forwarded, dropped], `${JSON.stringify(params)} on ${model}`);
  }
  rejects({ temperature: 'hot' }, 'invalid_parameter');
});

test('n > 1, audio and audio modalities are 400 unsupported_parameter; ignored fields never reach the Messages body', () => {
  rejects({ n: 2 }, 'unsupported_parameter');
  rejects({ audio: { voice: 'alloy', format: 'wav' } }, 'unsupported_parameter');
  rejects({ modalities: ['text', 'audio'] }, 'unsupported_parameter');
  const ignored = { n: 1, logprobs: true, top_logprobs: 2, seed: 7, frequency_penalty: 1, presence_penalty: 1, logit_bias: { 1: 2 }, user: 'u', metadata: { a: 'b' }, store: true, service_tier: 'auto' };
  const { body } = build(ignored);
  assert.deepEqual(Object.keys(body).sort(), ['cache_control', 'max_tokens', 'messages', 'model']);
});

test('prompt caching: top-level cache_control unless x-router-cache: off or anthropic.cache_control; anthropic merged last', () => {
  assert.deepEqual(build({}).body.cache_control, { type: 'ephemeral' });
  assert.ok(!('cache_control' in build({}, SAMPLING_OFF, false).body));
  assert.deepEqual(build({ anthropic: { cache_control: { type: 'ephemeral', ttl: '1h' } } }).body.cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.ok(!('cache_control' in build({ anthropic: { cache_control: null } }).body), 'anthropic.cache_control: null disables caching');
  const merged = build({
    reasoning_effort: 'low',
    anthropic: { thinking: { type: 'adaptive' }, output_config: { effort: 'max' }, top_k: 5, model: 'claude-other', stream: true },
  }).body;
  assert.deepEqual(merged.thinking, { type: 'adaptive' });
  assert.deepEqual(merged.output_config, { effort: 'max' }, 'shallow: the anthropic value replaces the translated one');
  assert.equal(merged.top_k, 5);
  assert.deepEqual([merged.model, 'stream' in merged], [SAMPLING_OFF, false], 'model and stream stay the gateway\'s');
  rejects({ anthropic: 'thinking' }, 'invalid_parameter');
  rejects({ anthropic: [1] }, 'invalid_parameter');
});

test('invalid message lists are 400 invalid_parameter', () => {
  for (const messages of [undefined, [], 'hi', [{ content: 'no role' }], [{ role: 'function', content: 'x' }], [{ role: 'system', content: 'only system' }]]) {
    rejects({ messages }, 'invalid_parameter');
  }
});

test('response translation: text, reasoning, tool calls, finish reasons, usage', () => {
  const msg = {
    id: 'msg_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5-20260101',
    content: [
      { type: 'thinking', thinking: 'Let me think.', signature: 's' },
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' world' },
      { type: 'tool_use', id: 'toolu_1', name: 'f', input: { a: 1 } },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 100, cache_creation_input_tokens: 400, cache_read_input_tokens: 2000, output_tokens: 50 },
  };
  const { body, usage } = translateResponse(msg, { model: 'claude-haiku-5-5', created: 1700000000 });
  assert.deepEqual(body, {
    id: 'msg_01',
    object: 'chat.completion',
    created: 1700000000,
    model: 'claude-haiku-5-5',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'Hello world',
          reasoning_content: 'Let me think.',
          tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
        },
        logprobs: null,
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 2500, completion_tokens: 50, total_tokens: 2550, prompt_tokens_details: { cached_tokens: 2000, cache_write_tokens: 400 } },
  });
  assert.deepEqual(usage, { prompt_tokens: 2500, completion_tokens: 50, cached_tokens: 2000, cache_write_tokens: 400, reasoning_tokens: 0 });

  const only = (/** @type {unknown[]} */ content, stop_reason = 'end_turn') =>
    translateResponse({ id: 'm', type: 'message', content, stop_reason }, { model: 'm', created: 0 }).body.choices[0];
  const toolOnly = only([{ type: 'thinking', thinking: '' }, { type: 'tool_use', id: 't', name: 'f', input: {} }], 'tool_use');
  assert.equal(toolOnly.message.content, null, 'null when only tool calls');
  assert.ok(!('reasoning_content' in toolOnly.message), 'empty (omitted) thinking is dropped');
  assert.equal(only([]).message.content, '');
  const reasons = {
    end_turn: 'stop',
    stop_sequence: 'stop',
    pause_turn: 'stop',
    max_tokens: 'length',
    model_context_window_exceeded: 'length',
    tool_use: 'tool_calls',
    refusal: 'content_filter',
  };
  for (const [stop, finish] of Object.entries(reasons)) assert.equal(only([{ type: 'text', text: 'x' }], stop).finish_reason, finish, stop);
});

// ---------------------------------------------------------------- streaming

/** @param {string} type @param {Record<string, unknown>} data */
const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const START = ev('message_start', {
  message: { id: 'msg_s1', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 100, cache_creation_input_tokens: 400, cache_read_input_tokens: 2000, output_tokens: 1 } },
});
/** @param {string} reason @param {number} [output] */
const END = (reason, output = 50) => ev('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: output } }) + ev('message_stop', {});
/** @param {number} index @param {Record<string, unknown>} block @param {Record<string, unknown>[]} deltas */
const block = (index, block, deltas) =>
  ev('content_block_start', { index, content_block: block }) + deltas.map((delta) => ev('content_block_delta', { index, delta })).join('') + ev('content_block_stop', { index });

/**
 * Feed a recorded Messages stream through the SSE parser and the translator. The translator takes
 * parsed events, so byte chunking only matters to the parser (covered in sse.test.js).
 * @param {string} sse @param {{includeUsage?: boolean}} [options]
 */
function translate(sse, { includeUsage = false } = {}) {
  const t = createStreamTranslator({ model: 'claude-haiku-5-5', created: 1700000000, includeUsage });
  const parser = createSSEParser();
  let out = '';
  /** @type {Record<string, any> | undefined} */
  let error;
  let done = false;
  /** @param {import('../../src/sse.js').SSEItem[]} items */
  const feed = (items) => {
    for (const item of items) {
      if (done || error) return;
      const step = t.onItem(item);
      out += step.out ?? '';
      if (step.error) error = step.error;
      if (step.done) done = true;
    }
  };
  feed(parser.push(new TextEncoder().encode(sse)));
  feed(parser.end());
  const chunks = out
    .split('\n\n')
    .filter(Boolean)
    .map((e) => JSON.parse(e.replace(/^data: /, '')));
  return { chunks, done, error, usage: t.usage, usageFinal: t.usageFinal };
}
/** @param {any[]} chunks */
const deltas = (chunks) => chunks.filter((c) => c.choices.length).map((c) => c.choices[0].delta);

test('stream: role chunk, text deltas, ping/empty thinking ignored, finish chunk', () => {
  const sse =
    START +
    block(0, { type: 'thinking', thinking: '', signature: '' }, [{ type: 'signature_delta', signature: 'sig' }]) +
    ev('ping', {}) +
    block(1, { type: 'text', text: '' }, [
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo é\u{1F600}' },
    ]) +
    END('end_turn');
  const whole = translate(sse);
  assert.deepEqual(deltas(whole.chunks), [{ role: 'assistant', content: '' }, { content: 'Hel' }, { content: 'lo é\u{1F600}' }, {}]);
  assert.deepEqual(
    whole.chunks.map((c) => c.choices[0]?.finish_reason),
    [null, null, null, 'stop'],
  );
  for (const c of whole.chunks) {
    assert.deepEqual([c.id, c.object, c.created, c.model], ['msg_s1', 'chat.completion.chunk', 1700000000, 'claude-haiku-5-5']);
  }
  assert.equal(whole.done, true);
  assert.equal(whole.chunks.some((c) => c.usage), false, 'no usage chunk unless include_usage');
  assert.deepEqual(whole.usage, { prompt_tokens: 2500, completion_tokens: 50, cached_tokens: 2000, cache_write_tokens: 400, reasoning_tokens: 0 });
  assert.equal(whole.usageFinal, true);
});

test('stream: include_usage adds the usage-only chunk (choices: []) before [DONE], with the cumulative message_delta count', () => {
  const sse = START + block(0, { type: 'text', text: '' }, [{ type: 'text_delta', text: 'x' }]) + END('max_tokens', 77);
  const { chunks, done } = translate(sse, { includeUsage: true });
  const last = chunks[chunks.length - 1];
  assert.deepEqual(last.choices, []);
  assert.deepEqual(last.usage, { prompt_tokens: 2500, completion_tokens: 77, total_tokens: 2577, prompt_tokens_details: { cached_tokens: 2000, cache_write_tokens: 400 } });
  assert.equal(chunks[chunks.length - 2].choices[0].finish_reason, 'length');
  assert.equal(done, true);
});

test('stream: parallel tool calls assembled from input_json_delta fragments', () => {
  const sse =
    START +
    block(0, { type: 'text', text: '' }, [{ type: 'text_delta', text: 'Checking both.' }]) +
    block(1, { type: 'tool_use', id: 'toolu_a', name: 'get_weather', input: {} }, [
      { type: 'input_json_delta', partial_json: '' },
      { type: 'input_json_delta', partial_json: '{"ci' },
      { type: 'input_json_delta', partial_json: 'ty": "Par' },
      { type: 'input_json_delta', partial_json: 'is"}' },
    ]) +
    block(2, { type: 'tool_use', id: 'toolu_b', name: 'get_time', input: {} }, [
      { type: 'input_json_delta', partial_json: '{"tz":' },
      { type: 'input_json_delta', partial_json: ' "CET"}' },
    ]) +
    END('tool_use');
  const { chunks } = translate(sse);
  const calls = deltas(chunks).flatMap((d) => d.tool_calls ?? []);
  assert.deepEqual(calls.slice(0, 1), [{ index: 0, id: 'toolu_a', type: 'function', function: { name: 'get_weather', arguments: '' } }]);
  /** @type {Record<number, {id?: string, name?: string, arguments: string}>} */
  const assembled = {};
  for (const c of calls) {
    const a = (assembled[c.index] ??= { arguments: '' });
    if (c.id) Object.assign(a, { id: c.id, name: c.function.name });
    a.arguments += c.function.arguments;
  }
  assert.deepEqual(assembled, {
    0: { id: 'toolu_a', name: 'get_weather', arguments: '{"city": "Paris"}' },
    1: { id: 'toolu_b', name: 'get_time', arguments: '{"tz": "CET"}' },
  });
  assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'tool_calls');
});

test('stream: non-empty thinking -> reasoning_content; refusal -> content_filter', () => {
  const sse =
    START +
    block(0, { type: 'thinking', thinking: '' }, [
      { type: 'thinking_delta', thinking: 'Consider ' },
      { type: 'thinking_delta', thinking: '' },
      { type: 'thinking_delta', thinking: 'carefully.' },
      { type: 'signature_delta', signature: 'sig' },
    ]) +
    block(1, { type: 'text', text: '' }, [{ type: 'text_delta', text: 'No.' }]) +
    END('refusal');
  const { chunks } = translate(sse);
  assert.deepEqual(deltas(chunks), [{ role: 'assistant', content: '' }, { reasoning_content: 'Consider ' }, { reasoning_content: 'carefully.' }, { content: 'No.' }, {}]);
  assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'content_filter');
});

test('stream: an error event (even after a 200) is reported, with whatever usage is known (not final)', () => {
  const sse = START + block(0, { type: 'text', text: '' }, [{ type: 'text_delta', text: 'partial' }]) + ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } });
  const r = translate(sse);
  assert.deepEqual(r.error, { type: 'overloaded_error', message: 'Overloaded' });
  assert.equal(r.done, false);
  assert.deepEqual(deltas(r.chunks), [{ role: 'assistant', content: '' }, { content: 'partial' }]);
  assert.equal(r.usage?.prompt_tokens, 2500);
  assert.equal(r.usageFinal, false, 'usage is final only once message_delta arrived');
});

test('stream: message_delta usage with null input/cache fields keeps the message_start counts', () => {
  const sse =
    START +
    block(0, { type: 'text', text: '' }, [{ type: 'text_delta', text: 'x' }]) +
    ev('message_delta', {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens: 60 },
    }) +
    ev('message_stop', {});
  const r = translate(sse, { includeUsage: true });
  assert.deepEqual(r.usage, { prompt_tokens: 2500, completion_tokens: 60, cached_tokens: 2000, cache_write_tokens: 400, reasoning_tokens: 0 });
  assert.equal(r.chunks[r.chunks.length - 1].usage.prompt_tokens, 2500);
  const later = translate(START + ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 120, output_tokens: 9 } }) + ev('message_stop', {}));
  assert.deepEqual([later.usage?.prompt_tokens, later.usage?.completion_tokens], [2520, 9], 'numeric fields still replace the start counts');
});

test('stream: a tool call with no input fragments ends with arguments "{}", like the non-streaming path', () => {
  const sse =
    START +
    block(0, { type: 'tool_use', id: 'toolu_a', name: 'list_files', input: {} }, []) +
    block(1, { type: 'tool_use', id: 'toolu_b', name: 'now', input: {} }, [{ type: 'input_json_delta', partial_json: '' }]) +
    block(2, { type: 'tool_use', id: 'toolu_c', name: 'f', input: {} }, [{ type: 'input_json_delta', partial_json: '{"a":1}' }]) +
    END('tool_use');
  const calls = deltas(translate(sse).chunks).flatMap((d) => d.tool_calls ?? []);
  /** @type {Record<number, string>} */
  const args = {};
  for (const c of calls) args[c.index] = (args[c.index] ?? '') + c.function.arguments;
  assert.deepEqual(args, { 0: '{}', 1: '{}', 2: '{"a":1}' });
  for (const [index, a] of Object.entries(args)) assert.doesNotThrow(() => JSON.parse(a), `tool call ${index}`);
});
