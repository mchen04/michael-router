// Recent error/auth event log: the store keeps the 200 newest events (JSON text), listed newest first.
// Events hold allowlisted metadata only. Their `message` is gateway-authored text chosen by code
// (EVENT_MESSAGES), never upstream or client text: provider errors and gateway errors can quote
// the request, and the client already receives that text in its error response.

export const EVENTS_MAX = 200;
export const EVENT_KINDS = Object.freeze(['auth', 'upstream', 'gateway']);

/** Static event texts by code. */
export const EVENT_MESSAGES = Object.freeze({
  invalid_credentials: 'Wrong password.',
  not_found: 'Unknown path.',
  method_not_allowed: 'Wrong method for the path.',
  invalid_json: 'The request body is not a JSON object.',
  model_required: 'The request names no model.',
  invalid_model: 'The model name breaks the naming rule.',
  model_not_allowed: 'OpenRouter accepts only free models without paid extras.',
  admin_required: 'An admin password is required for control routes.',
  cross_origin_forbidden: 'Cross-origin requests are not allowed.',
  model_not_routable: 'No routing rule matches the model name.',
  payload_too_large: 'The request body is over the size limit.',
  invalid_parameter: 'A request field has the wrong shape or value.',
  unsupported_parameter: 'A request field is not supported for Claude models.',
  unsupported_content: 'A content part is not supported for Claude models.',
  invalid_tool_arguments: 'Assistant tool call arguments are not a JSON object.',
  invalid_provider: 'Unknown provider id.',
  invalid_key: 'The key has an invalid shape.',
  provider_not_configured: 'The routed provider has no key.',
  provider_key_undecryptable: 'The stored key override could not be decrypted; the provider counts as not configured.',
  store_unavailable: 'The store failed or was too slow.',
  internal_error: 'Unexpected gateway error.',
  provider_auth_failed: "The provider rejected the router's key.",
  provider_billing: 'The provider refused for billing or credits.',
  provider_forbidden: 'The provider refused the request (permission or moderation).',
  provider_rate_limited: 'The provider rate-limited the request.',
  provider_error: 'The provider failed or answered with something unusable.',
  upstream_unreachable: 'The provider could not be reached, or it redirected.',
  upstream_timeout: 'The provider did not finish in time.',
  upstream_stream_incomplete: 'The provider stream broke or ended early.',
  key_rejected: 'The provider rejected a key sent for storage; it was not stored.',
  key_verification_unavailable: 'A key sent for storage could not be verified; it was not stored.',
});

/** @param {unknown} n @returns {n is number} */
const isCount = (n) => Number.isSafeInteger(n) && /** @type {number} */ (n) > 0;

/**
 * @typedef {{kind: 'auth' | 'upstream' | 'gateway', code: string, status: number, upstream_status?: number,
 *   provider?: string, model?: string, source?: string, block_seconds?: number}} EventInput
 */

/**
 * The static text for an event: by code, else by kind (provider codes are the provider's own).
 * @param {{kind: string, code: string, status: number, upstream_status?: number, block_seconds?: number}} e
 */
export function eventMessage({ kind, code, status, upstream_status, block_seconds }) {
  if (code === 'invalid_credentials' && isCount(block_seconds)) return `Wrong password; the source is blocked for ${block_seconds} s.`;
  if (Object.hasOwn(EVENT_MESSAGES, code)) return EVENT_MESSAGES[/** @type {keyof typeof EVENT_MESSAGES} */ (code)];
  if (kind !== 'upstream') return 'Request refused.';
  if (status === 200) return 'The provider reported an error inside the stream.';
  return `The provider answered HTTP ${isCount(upstream_status) ? upstream_status : status}.`;
}

/**
 * `{ts, kind, code, status, upstream_status?, provider?, model?, message, source? (auth only), request_id}`
 * @param {EventInput} input
 * @param {{scrub: (s: unknown) => string, now: () => number, requestId: string}} ctx
 */
export function buildEvent({ kind, code, status, upstream_status, provider, model, source, block_seconds }, { scrub, now, requestId }) {
  /** @type {Record<string, unknown>} */
  const event = { ts: new Date(now()).toISOString(), kind, code, status };
  if (isCount(upstream_status)) event.upstream_status = upstream_status;
  if (provider) event.provider = provider;
  if (model) event.model = scrub(String(model)).slice(0, 128);
  event.message = eventMessage({ kind, code, status, upstream_status, block_seconds });
  if (kind === 'auth' && source) event.source = source;
  event.request_id = requestId;
  return event;
}

/**
 * @param {import('./store/index.js').Store} store
 * @param {Record<string, unknown>} event
 */
export async function appendEvent(store, event) {
  await store.appendEvent(JSON.stringify(event), EVENTS_MAX);
}

/**
 * @param {import('./store/index.js').Store} store
 * @param {{limit?: number, kind?: string}} [options]
 */
export async function listEvents(store, { limit = 50, kind } = {}) {
  const raw = await store.listEvents(EVENTS_MAX);
  const events = [];
  for (const line of Array.isArray(raw) ? raw : []) {
    try {
      const e = JSON.parse(line);
      if (e && typeof e === 'object' && (!kind || e.kind === kind)) events.push(e);
    } catch {
      // skip malformed entries
    }
    if (events.length >= limit) break;
  }
  return events;
}

/**
 * Per-request recorder; writes happen in the background via waitUntil and never fail the request.
 * @param {{store: import('./store/index.js').Store | null, waitUntil: (p: Promise<unknown>) => void,
 *   scrub: (s: unknown) => string, now: () => number, requestId: string}} options
 */
export function createEventRecorder({ store, waitUntil, scrub, now, requestId }) {
  return {
    /** @param {EventInput} input */
    record(input) {
      if (!store) return;
      waitUntil(appendEvent(store, buildEvent(input, { scrub, now, requestId })));
    },
  };
}
