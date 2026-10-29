import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRequest } from '../../src/providers/claude.js';
import { gemini, openai, openrouter } from '../../src/providers/passthrough.js';
import { PRICING } from '../../src/pricing.js';

const messages = [{ role: 'user', content: 'Hello' }];
const sent = (adapter, body) => JSON.parse(String(adapter.prepare(body, JSON.stringify(body)).payload));
const claude = (body = {}) => buildRequest({ messages, ...body }, { model: 'claude-opus-5-5', cache: false }).body;

for (const stream of [false, true]) {
  test(`omitted effort defaults to medium for every direct provider with stream=${stream}`, () => {
    assert.equal(claude({ stream }).output_config?.effort, 'medium');
    assert.equal(sent(openai, { model: 'gpt-6.1-sol', messages, stream }).reasoning_effort, 'medium');
    assert.equal(sent(gemini, { model: 'gemini-3.5-flash-lite', messages, stream }).reasoning_effort, 'medium');
  });
}

test('explicit effort values take priority over the default', () => {
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(claude({ reasoning_effort: effort }).output_config.effort, ['none', 'minimal'].includes(effort) ? 'low' : effort);
    for (const adapter of [openai, gemini]) assert.equal(sent(adapter, { messages, reasoning_effort: effort }).reasoning_effort, effort);
  }
  for (const adapter of [openai, gemini]) assert.equal(sent(adapter, { messages, reasoning_effort: null }).reasoning_effort, null);
});

test('native effort and output configuration do not receive the default', () => {
  assert.deepEqual(claude({ output_config: { effort: 'high' } }).output_config, { effort: 'high' });
  assert.deepEqual(claude({ output_config: {} }).output_config, {});
  assert.deepEqual(claude({ anthropic: { output_config: { effort: 'max' } } }).output_config, { effort: 'max' });
  const body = { model: 'gpt-6.1-sol', messages, reasoning: { effort: 'high' } };
  assert.deepEqual(sent(openai, body), body);
  for (const field of ['thinking_level', 'thinking_budget']) {
    const native = { model: 'gemini-3.5-flash-lite', messages, extra_body: { google: { thinking_config: { [field]: field === 'thinking_budget' ? 0 : 'low' } } } };
    assert.deepEqual(sent(gemini, native), native);
  }
});

test('known non-reasoning OpenAI metadata suppresses only the default', () => {
  const entry = PRICING.models['gpt-6.1-sol'];
  const before = entry.reasoning_effort;
  entry.reasoning_effort = false;
  try {
    assert.equal(Object.hasOwn(sent(openai, { model: 'gpt-6.1-sol', messages }), 'reasoning_effort'), false);
    assert.equal(sent(openai, { model: 'gpt-6.1-sol', messages, reasoning_effort: 'high' }).reasoning_effort, 'high');
  } finally {
    if (before === undefined) delete entry.reasoning_effort;
    else entry.reasoning_effort = before;
  }
  assert.equal(sent(openai, { model: 'gpt-future', messages }).reasoning_effort, 'medium');
});

test('OpenRouter retains its existing guarded body without adding effort', () => {
  for (const effort of [undefined, 'low']) {
    const body = { model: 'openrouter/free', messages, ...(effort === undefined ? {} : { reasoning_effort: effort }) };
    assert.deepEqual(sent(openrouter, body), { ...body, models: [body.model], provider: { allow_fallbacks: false, max_price: { prompt: 0, completion: 0, request: 0, image: 0 } } });
  }
});
