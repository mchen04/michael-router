// Shared HTTP helpers: JSON responses, the OpenAI-style error envelope, bounded JSON body reads.
import { Buffer } from 'node:buffer';

/** An error that maps directly to a gateway_error response. */
export class GatewayError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {Record<string, string>} [headers]
   */
  constructor(status, code, message, headers = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

/**
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
export function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/**
 * `{"error":{"message","type","code","param":null,"provider"?,"upstream_status"?}}`
 * @param {{message: string, code: string, type?: string, provider?: string, upstream_status?: number}} e
 */
export function errorEnvelope({ message, code, type = 'gateway_error', provider, upstream_status }) {
  /** @type {Record<string, unknown>} */
  const error = { message, type, code, param: null };
  if (provider !== undefined) error.provider = provider;
  if (upstream_status !== undefined) error.upstream_status = upstream_status;
  return { error };
}

/**
 * Read a JSON object body of at most `maxBytes`.
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Promise<Record<string, any>>}
 */
export async function readJsonBody(request, maxBytes) {
  return (await readBody(request, maxBytes)).json;
}

/**
 * Read a JSON object body of at most `maxBytes`, keeping the raw bytes (pass-through forwards them).
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Promise<{bytes: Buffer, json: Record<string, any>}>}
 */
export async function readBody(request, maxBytes) {
  const tooLarge = () => new GatewayError(413, 'payload_too_large', `Request body exceeds ${maxBytes} bytes.`);
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = Buffer.concat(chunks);
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new GatewayError(400, 'invalid_json', 'Request body is not valid JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GatewayError(400, 'invalid_json', 'Request body must be a JSON object.');
  }
  return { bytes, json: parsed };
}

/**
 * @param {Record<string, number | undefined>} timings milliseconds
 * @returns {string} e.g. `auth;dur=2.1, store;dur=0.8`
 */
export function serverTimingHeader(timings) {
  return Object.entries(timings)
    .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
    .map(([k, v]) => `${k};dur=${/** @type {number} */ (v).toFixed(1)}`)
    .join(', ');
}
