// Gemini/OpenRouter pass-through specifics: provider key failures and stream usage finality.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRelay, openai } from '../../src/providers/passthrough.js';
import { mapUpstreamStatus, parseUpstreamError } from '../../src/proxy.js';

test('Gemini key failures: invalid or expired message, or details[].reason API_KEY_INVALID -> 502 provider_auth_failed', () => {
  /** @param {string} message @param {unknown[]} [details] */
  const body = (message, details) => JSON.stringify([{ error: { code: 400, message, status: 'INVALID_ARGUMENT', ...(details ? { details } : {}) } }]);
  const reason = [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }];
  for (const text of [body('API key not valid. Please pass a valid API key.'), body('API key expired. Please renew the API key.'), body('Request failed.', reason)]) {
    assert.deepEqual(mapUpstreamStatus('gemini', 400, parseUpstreamError(text)), { status: 502, code: 'provider_auth_failed' }, text);
  }
  const other = parseUpstreamError(body('Request contains an invalid argument.', [{ reason: 'BAD_FIELD' }]));
  assert.deepEqual(mapUpstreamStatus('gemini', 400, other), { status: 400, code: null });
  assert.deepEqual(mapUpstreamStatus('openrouter', 400, parseUpstreamError(body('Request failed.', reason))), { status: 400, code: null }, 'Gemini only');
});

test('pass-through stream usage is final only after [DONE], on a finish_reason chunk or from the usage-only chunk', () => {
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  /** @param {Record<string, unknown>} extra @param {string | null} [finish] */
  const chunk = (extra, finish = null) => ({ data: JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'x' }, finish_reason: finish }], ...extra }) });
  /** @param {{data: string}[]} items */
  const run = (items) => {
    const relay = createRelay({ stripUsageOnly: false });
    for (const item of items) relay.onItem(item);
    return [relay.usage?.completion_tokens, relay.usageFinal];
  };
  assert.deepEqual(run([chunk({ usage })]), [5, false], 'usage on a mid-stream chunk, then the stream broke');
  assert.deepEqual(run([chunk({ usage }), { data: '[DONE]' }]), [5, true]);
  assert.deepEqual(run([chunk({ usage }, 'stop')]), [5, true]);
  assert.deepEqual(run([chunk({}), { data: JSON.stringify({ choices: [], usage }) }]), [5, true]);
  assert.deepEqual(run([chunk({})]), [undefined, false]);
});

test('OpenAI requests send max_tokens as max_completion_tokens, and keep an explicit max_completion_tokens', () => {
  const sent = (body) => JSON.parse(String(openai.prepare(body, JSON.stringify(body)).payload));
  const streamed = JSON.parse(openai.prepare({ model: 'gpt-6-luna', messages: [], stream: true, max_tokens: 8 }, '').payload);
  assert.equal(streamed.max_completion_tokens, 8);
  const renamed = sent({ model: 'gpt-6-luna', messages: [], max_tokens: 64 });
  assert.equal(renamed.max_completion_tokens, 64);
  assert.equal(Object.hasOwn(renamed, 'max_tokens'), false);
  const explicit = sent({ model: 'gpt-6-luna', messages: [], max_tokens: 64, max_completion_tokens: 128 });
  assert.equal(explicit.max_completion_tokens, 128);
  assert.equal(Object.hasOwn(explicit, 'max_tokens'), false);
  assert.equal(Object.hasOwn(sent({ model: 'gpt-6-luna', messages: [] }), 'max_completion_tokens'), false);
});
