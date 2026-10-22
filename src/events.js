// Recent error/auth event log: `mr:v1:events`, LPUSH + LTRIM 0 199, newest first. Scrubbed.

export const EVENTS_KEY = 'mr:v1:events';
export const EVENTS_MAX = 200;
export const EVENT_KINDS = Object.freeze(['auth', 'upstream', 'gateway']);

/**
 * @typedef {{kind: 'auth' | 'upstream' | 'gateway', code: string, status: number, provider?: string,
 *   model?: string, message?: string, source?: string}} EventInput
 */

/**
 * `{ts, kind, code, status, provider?, model?, message?, source? (auth only), request_id}`
 * @param {EventInput} input
 * @param {{scrub: (s: unknown) => string, now: () => number, requestId: string}} ctx
 */
export function buildEvent({ kind, code, status, provider, model, message, source }, { scrub, now, requestId }) {
  /** @type {Record<string, unknown>} */
  const event = { ts: new Date(now()).toISOString(), kind, code, status };
  if (provider) event.provider = provider;
  if (model) event.model = scrub(String(model)).slice(0, 128);
  if (message) event.message = scrub(String(message)).slice(0, 300); // truncated after scrubbing
  if (kind === 'auth' && source) event.source = source;
  event.request_id = requestId;
  return event;
}

/**
 * @param {import('./store/index.js').Store} store
 * @param {Record<string, unknown>} event
 */
export async function appendEvent(store, event) {
  await store.pipeline([
    ['LPUSH', EVENTS_KEY, JSON.stringify(event)],
    ['LTRIM', EVENTS_KEY, 0, EVENTS_MAX - 1],
  ]);
}

/**
 * @param {import('./store/index.js').Store} store
 * @param {{limit?: number, kind?: string}} [options]
 */
export async function listEvents(store, { limit = 50, kind } = {}) {
  const raw = await store.command(['LRANGE', EVENTS_KEY, 0, EVENTS_MAX - 1]);
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
