// Model name -> provider (DESIGN §5.3). First match wins:
//   contains "/" -> openrouter (model forwarded unchanged), "claude-" -> claude, "gemini-" -> gemini.
import { GatewayError } from './http.js';

export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

const RULES =
  'Route by model name: a name containing "/" goes to OpenRouter (e.g. "openrouter/free", "vendor/model:free"), ' +
  'a name starting with "claude-" to Claude, "gemini-" to Gemini, or "gpt-" or o followed by a digit to OpenAI.';

/**
 * @param {unknown} model
 * @returns {{provider: 'claude' | 'gemini' | 'openrouter' | 'openai', model: string}}
 */
export function routeModel(model) {
  if (model === undefined || model === null || model === '') {
    throw new GatewayError(400, 'model_required', 'The request body must include "model".');
  }
  if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) {
    throw new GatewayError(400, 'invalid_model', 'Invalid model name: use 1-128 characters from A-Z a-z 0-9 . _ : / @ + - starting with a letter or digit.');
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
