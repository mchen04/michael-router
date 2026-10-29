// Allowlisted structured logger: one JSON line per request; unknown fields are dropped.
// Unexpected exceptions log only their name: an exception message can quote request or upstream text.
import { scrub as scrubPatterns } from './redact.js';

export const LOG_FIELDS = Object.freeze([
  'request_id',
  'route',
  'method',
  'status',
  'provider',
  'model',
  'duration_ms',
  'upstream_ms',
  'store_ms',
  'error_code',
  'cold',
]);
export const EXCEPTION_FIELDS = Object.freeze(['request_id', 'exception']);

/** @param {unknown} v */
const primitive = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/**
 * @param {{sink?: (line: string) => void, errorSink?: (line: string) => void}} [options]
 */
export function createLogger({ sink = (line) => console.log(line), errorSink = (line) => console.error(line) } = {}) {
  return {
    /**
     * @param {Record<string, unknown>} fields
     * @param {(s: unknown) => string} [scrub]
     */
    request(fields, scrub = scrubPatterns) {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const k of LOG_FIELDS) {
        const v = fields[k];
        if (v === undefined || !primitive(v)) continue;
        out[k] = typeof v === 'string' ? scrub(v).slice(0, 200) : v;
      }
      sink(JSON.stringify(out));
    },
    /**
     * @param {unknown} err
     * @param {{requestId?: string, redact?: (text: unknown) => string}} [ctx]
     */
    exception(err, ctx = {}) {
      const e = /** @type {{name?: unknown}} */ (err ?? {});
      const name = typeof e.name === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(e.name) ? e.name : 'Error';
      errorSink(JSON.stringify({ request_id: ctx.requestId ?? null, exception: ctx.redact ? ctx.redact(name) : scrubPatterns(name) }));
    },
  };
}
