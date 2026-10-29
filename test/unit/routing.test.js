import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GatewayError } from '../../src/http.js';
import { routeModel } from '../../src/routing.js';

test('routing table: "/" -> openrouter (first match), claude- -> claude, gemini- -> gemini; names forwarded unchanged', () => {
  const cases = [
    ['anthropic/claude-sonnet-5-5:free', 'openrouter'],
    ['openrouter/free', 'openrouter'],
    ['claude-x/y:free', 'openrouter'],
    ['gemini-2.5-flash/variant:free', 'openrouter'],
    ['gpt-6.1-sol', 'openai'],
    ['o3', 'openai'],
    ['o4-mini', 'openai'],
    ['gpt-x/y:free', 'openrouter'],
    ['claude-haiku-5-5', 'claude'],
    ['claude-', 'claude'],
    ['gemini-2.5-flash-lite', 'gemini'],
  ];
  for (const [model, provider] of cases) assert.deepEqual(routeModel(model), { provider, model }, model);
});

test('missing, malformed and unroutable model names are 400s with distinct codes', () => {
  /** @param {unknown} model @param {string} code */
  const rejects = (model, code) =>
    assert.throws(
      () => routeModel(model),
      (/** @type {any} */ e) => e instanceof GatewayError && e.status === 400 && e.code === code,
      JSON.stringify(model),
    );
  for (const m of [undefined, null, '']) rejects(m, 'model_required');
  for (const m of [42, ['claude-x'], { id: 'claude-x' }, ' claude-x', '-claude', 'claude x', 'claude-é', 'claude-x\n', `claude-${'a'.repeat(122)}`]) {
    rejects(m, 'invalid_model');
  }
  assert.equal(routeModel(`claude-${'a'.repeat(121)}`).model.length, 128, '128 characters is the maximum');
  for (const m of ['other-model', 'Claude-haiku-5-5', 'GEMINI-2.5-pro', 'o-series']) rejects(m, 'model_not_routable');
  assert.throws(() => routeModel('other-model'), /contain.*"\/".*"claude-".*"gemini-".*"gpt-"/s, 'the message lists the three rules');
});
