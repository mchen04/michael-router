// HTTP client for the router: base URL rules, bearer auth, timeouts, redirect refusal and the
// mapping of failures to exit codes (DESIGN §9) using `x-router-error-source` and the error envelope.
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import { VERSION } from '../../src/version.js';
import { CliError, EXIT, usageError } from './errors.js';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const USER_AGENT = `mrouter/${VERSION}`;

/**
 * Normalize a router URL: https (http only for localhost, 127.0.0.1 and ::1), no credentials,
 * query or fragment, a host that parses as written, no trailing slash, and a trailing `/v1`
 * (the OpenAI base URL) removed.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeUrl(raw) {
  const text = raw.trim();
  // The URL parser reads `\` as `/` and drops tabs and newlines, so such input can name a
  // different host than it appears to.
  if (/[\\\s\u0000-\u001f\u007f]/.test(text)) throw usageError('the router URL must not contain backslashes, spaces or control characters');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw usageError('the router URL is not a valid URL (expected https://<host>)');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw usageError('the router URL must use https:// (http:// only for localhost, 127.0.0.1 or ::1)');
  }
  if (url.username || url.password) throw usageError('the router URL must not contain credentials');
  if (url.search || url.hash) throw usageError('the router URL must not have a query or fragment');
  // The host the parser settled on must be the host as typed (no percent-encoding, IPv4
  // shorthand or other rewriting), apart from letter case and a default port.
  const typed = /^https?:\/\/([^/?#]*)/i.exec(text)?.[1].toLowerCase();
  if (typed !== url.host && typed !== `${url.host}:${url.protocol === 'https:' ? 443 : 80}`) {
    throw usageError(`the router URL's host is read as "${url.host}", which is not how it is written; write ${url.protocol}//${url.host}`);
  }
  const pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${url.origin}${pathname}`;
}

/** @param {string} text */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Strip control characters from server-provided text before it reaches the terminal. @param {unknown} s */
export const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();

/** @param {string | null} retryAfter */
function retryText(retryAfter) {
  if (!retryAfter) return '';
  return /^\d+$/.test(retryAfter) ? ` Retry after ${retryAfter} s.` : ` Retry after ${clean(retryAfter)}.`;
}

/**
 * Map a non-2xx router response to a CliError.
 * @param {{status: number, headers: Headers}} res
 * @param {string} text the response body
 * @returns {CliError}
 */
export function responseError(res, text) {
  const body = parseJson(text);
  const e = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : null;
  const header = res.headers.get('x-router-error-source');
  const source = header ?? (e?.type === 'upstream_error' ? 'upstream' : e?.type === 'gateway_error' ? 'gateway' : null);
  const retry = retryText(res.headers.get('retry-after'));
  const code = e && typeof e.code === 'string' ? clean(e.code) : 'unknown_error';
  const message = sentence(e && typeof e.message === 'string' ? clean(e.message) : '');
  const info = { status: res.status, code };
  if (source === 'upstream') {
    const provider = clean(e?.provider ?? res.headers.get('x-router-provider') ?? 'provider');
    const upstreamStatus = Number.isInteger(e?.upstream_status) ? e.upstream_status : undefined;
    const upstream = upstreamStatus !== undefined && upstreamStatus !== res.status ? `, provider answered ${upstreamStatus}` : '';
    return new CliError(`upstream error from ${provider} (HTTP ${res.status}${upstream}, ${code}): ${message}${retry}`, EXIT.UPSTREAM, { ...info, upstreamStatus });
  }
  if (source === 'gateway') {
    const text = `router refused the request (HTTP ${res.status}, ${code}): ${message}${retry}`;
    if (res.status === 401 || res.status === 429) {
      const hint = code === 'invalid_credentials' ? "run 'mrouter login' or check MROUTER_PASSWORD" : undefined;
      return new CliError(text, EXIT.GATEWAY, { ...info, hint });
    }
    return new CliError(text, EXIT.ERROR, info);
  }
  // Vercel answers by itself (no router headers) when the function crashed, timed out or never
  // ran (FUNCTION_INVOCATION_TIMEOUT, FUNCTION_PAYLOAD_TOO_LARGE, DEPLOYMENT_NOT_FOUND, …).
  const platform = res.headers.get('x-vercel-error');
  if (platform) {
    const platformCode = /^[A-Z0-9_]{1,64}$/.test(platform) ? platform : 'unknown';
    return new CliError(`Vercel platform error (HTTP ${res.status}, ${platformCode}): the hosting platform answered, not the router`, EXIT.ERROR, {
      status: res.status,
      code: platformCode,
    });
  }
  return new CliError(`unexpected HTTP ${res.status} response (not from Michael Router? check the URL)`, EXIT.ERROR, { status: res.status });
}

/** @param {string} s */
const sentence = (s) => (s === '' ? 'no message.' : /[.!?]$/.test(s) ? s : `${s}.`);

/**
 * Map a fetch or body-read failure to a CliError (exit 5).
 * @param {unknown} err
 * @param {string} origin
 * @param {number} timeoutMs
 * @param {boolean} midway the response had started
 */
export function networkError(err, origin, timeoutMs, midway = false) {
  const e = /** @type {any} */ (err);
  if (e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError') {
    return new CliError(`no complete response from ${origin} within ${timeoutMs / 1000} s (use --timeout to change)`, EXIT.NETWORK, { timeout: true });
  }
  const causeText = String(e?.cause?.message ?? '');
  if (/redirect/i.test(causeText)) {
    return new CliError(`${origin} answered with a redirect; mrouter never follows redirects (check the URL)`, EXIT.NETWORK);
  }
  if (midway) return new CliError(`the connection to ${origin} broke before the response was complete`, EXIT.NETWORK, { code: 'connection_broken' });
  const code = typeof e?.cause?.code === 'string' ? ` (${clean(e.cause.code)})` : '';
  return new CliError(`cannot reach ${origin}${code}`, EXIT.NETWORK);
}

/**
 * Read a response body fully, noting when the first byte arrived.
 * @param {Response} res
 * @param {number} t0 performance.now() at request start
 */
async function readTimed(res, t0) {
  let firstByteMs;
  const chunks = [];
  if (res.body) {
    for await (const chunk of res.body) {
      firstByteMs ??= performance.now() - t0;
      chunks.push(chunk);
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), firstByteMs: firstByteMs ?? performance.now() - t0 };
}

/**
 * @param {{url: string, password: string, timeoutMs: number}} options
 */
export function createClient({ url, password, timeoutMs }) {
  const origin = new URL(url).origin;

  /**
   * Send a request; resolve with the open response (2xx only) and its start time.
   * @param {string} method @param {string} path @param {unknown} [body]
   */
  async function open(method, path, body) {
    const signal = AbortSignal.timeout(timeoutMs);
    /** @type {Record<string, string>} */
    const headers = { authorization: `Bearer ${password}`, accept: 'application/json', 'user-agent': USER_AGENT };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const t0 = performance.now();
    let res;
    try {
      res = await fetch(url + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', // the password never follows a redirect
        signal,
      });
    } catch (err) {
      throw networkError(err, origin, timeoutMs);
    }
    if (!res.ok) {
      let text = '';
      try {
        text = (await readTimed(res, t0)).text;
      } catch (err) {
        throw networkError(err, origin, timeoutMs, true);
      }
      throw responseError(res, text);
    }
    return { res, t0 };
  }

  /**
   * A complete JSON request.
   * @param {string} method @param {string} path @param {unknown} [body]
   */
  async function request(method, path, body) {
    const { res, t0 } = await open(method, path, body);
    let read;
    try {
      read = await readTimed(res, t0);
    } catch (err) {
      throw networkError(err, origin, timeoutMs, true);
    }
    const json = parseJson(read.text);
    if (json === undefined) throw new CliError(`unexpected response from ${origin}${path} (not JSON)`);
    return { res, json, ttfbMs: read.firstByteMs, totalMs: performance.now() - t0 };
  }

  return {
    origin,
    open,
    request,
    /** @param {string} path */
    get: (path) => request('GET', path),
    /** @param {unknown} err @param {boolean} [midway] */
    networkError: (err, midway = true) => networkError(err, origin, timeoutMs, midway),
  };
}
