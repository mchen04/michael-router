// Route table, authentication pipeline and the top-level error boundary.
//
// createHandler() returns `handle(request, platform?)`. `platform` is optional:
//   { waitUntil?(promise), remoteAddress?: string }   (dev/server.js passes both; Vercel neither)
//
// Route handlers receive a per-request `ctx`:
//   requestId, request, url, method, params, config, now(), sleep(ms), cold, instance,
//   timings {auth, store, upstream}, store (timed, fail-closed), waitUntil(promise),
//   source {id, display}, keys {claude|gemini|openrouter: {provider, configured, source, updated_at, key}},
//   events.record({kind, code, status, upstream_status?, provider?, model?, source?, block_seconds?})
//   (allowlisted metadata only, never request or upstream text), redact(text), redactor,
//   log {provider, model, upstream_ms} (fields for the request log line),
//   fail(status, code, message, headers?) -> gateway_error Response (recorded as a gateway event),
//   deferLog / finishLog(status) (streaming routes log at stream end), verifyProviderKey,
//   upstreamTimeoutMs.
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { bearerCredential, createAuthenticator } from './auth.js';
import { loadConfig } from './config.js';
import * as control from './control.js';
import { createEventRecorder } from './events.js';
import { GatewayError, errorEnvelope, jsonResponse, serverTimingHeader } from './http.js';
import { createKeyResolver } from './keys.js';
import { createLimiter } from './limiter.js';
import { createLogger } from './log.js';
import { UPSTREAM_TIMEOUT_MS, chatCompletions, listModels, verifyProviderKey as defaultVerifyProviderKey } from './proxy.js';
import { createRedactor } from './redact.js';
import { resolveSource } from './source.js';
import { STORE_METHODS, StoreError, createStore, failClosed } from './store/index.js';

/** @type {{method: string, path: string, handler: (ctx: any) => Response | Promise<Response>}[]} */
export const ROUTES = [
  { method: 'POST', path: '/v1/chat/completions', handler: chatCompletions },
  { method: 'GET', path: '/v1/models', handler: listModels },
  { method: 'GET', path: '/control/health', handler: control.health },
  { method: 'GET', path: '/control/keys', handler: control.listKeys },
  { method: 'PUT', path: '/control/keys/:provider', handler: control.setKey },
  { method: 'DELETE', path: '/control/keys/:provider', handler: control.unsetKey },
  { method: 'GET', path: '/control/usage', handler: control.usage },
  { method: 'GET', path: '/control/errors', handler: control.errors },
];

const REJECTIONS = {
  source_blocked: 'Too many failed attempts from this source; it is temporarily blocked.',
  auth_backoff: 'Too many failed attempts; retry after the indicated delay.',
  auth_busy: 'Too many concurrent authentication attempts from this source.',
};

/**
 * The route path: `__route` when Vercel rewrote to /api/router, else the pathname (dev server).
 * @param {URL} url
 * @returns {string | null}
 */
export function routePath(url) {
  if (url.pathname !== '/api/router') return url.pathname;
  const route = url.searchParams.get('__route');
  return route === null ? null : `/${route.replace(/^\/+/, '')}`;
}

/** Everything under /v1 and /control (and the function path itself) requires auth first. @param {URL} url */
export function isProtected(url) {
  return url.pathname === '/api/router' || /^\/(v1|control)(\/|$)/.test(url.pathname);
}

/**
 * @param {string} path
 * @param {string} method
 * @returns {{route: typeof ROUTES[number], params: Record<string, string>} | {status: 404} | {status: 405, allow: string[]}}
 */
export function matchRoute(path, method) {
  const segments = path.split('/');
  /** @type {string[]} */
  const allow = [];
  for (const route of ROUTES) {
    const pattern = route.path.split('/');
    if (pattern.length !== segments.length) continue;
    /** @type {Record<string, string>} */
    const params = {};
    const ok = pattern.every((p, i) => {
      if (p.startsWith(':')) {
        params[p.slice(1)] = segments[i];
        return segments[i] !== '';
      }
      return p === segments[i];
    });
    if (!ok) continue;
    if (route.method === method) return { route, params };
    allow.push(route.method);
  }
  return allow.length ? { status: 405, allow } : { status: 404 };
}

/**
 * Names variables only, never values.
 * @param {{problems: readonly string[], passwordConflict: boolean}} config
 */
function misconfiguredMessage({ problems, passwordConflict }) {
  const parts = [];
  let rest = problems;
  if (passwordConflict) {
    parts.push('ROUTER_PASSWORD_HASH and ROUTER_PASSWORD are both set (set exactly one)');
    rest = problems.filter((p) => p !== 'ROUTER_PASSWORD_HASH' && p !== 'ROUTER_PASSWORD');
  }
  if (rest.length) parts.push(`${rest.join(', ')} ${rest.length === 1 ? 'is' : 'are'} missing or invalid`);
  return `Server misconfigured: ${parts.join('; ')}.`;
}

/** @param {number} ms */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** @param {number} ms */
const round1 = (ms) => Math.round(ms * 10) / 10;

/**
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   waitUntil?: (p: Promise<unknown>) => void,
 *   store?: import('./store/index.js').Store,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   verifyPassword?: typeof import('./auth.js').verifyPassword,
 *   verifyProviderKey?: typeof defaultVerifyProviderKey,
 *   upstreamTimeoutMs?: number,
 *   logSink?: (line: string) => void,
 *   errorSink?: (line: string) => void,
 *   attachDatabasePool?: (pool: import('pg').Pool) => void,
 * }} [options] everything except `env`, `waitUntil` and `attachDatabasePool` is for tests/dev
 *   (Vercel's attachDatabasePool keeps the instance alive for the pool's idle timeout plus about
 *   100 ms after each client release, so pg-pool closes its idle clients before the instance
 *   suspends)
 */
export function createHandler(options = {}) {
  const config = loadConfig(options.env ?? {});
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const logger = createLogger({ sink: options.logSink, errorSink: options.errorSink });
  const baseRedactor = createRedactor(config.secrets);
  const problems = config.problems;
  const configured = problems.length === 0;
  const store = !configured ? null : options.store ? failClosed(options.store) : createStore(config.store, { onPool: options.attachDatabasePool });
  const authenticator = configured
    ? createAuthenticator({ passwordHash: config.passwordHash, password: config.password, verifyPassword: options.verifyPassword })
    : null;
  const keyResolver = createKeyResolver(config);
  const verifyProviderKey = options.verifyProviderKey ?? defaultVerifyProviderKey;
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const instance = { startedAt: now(), requests: 0 };
  const misconfigured = misconfiguredMessage(config);

  /**
   * @param {Request} request
   * @param {{waitUntil?: (p: Promise<unknown>) => void, remoteAddress?: string}} [platform]
   * @returns {Promise<Response>}
   */
  return async function handle(request, platform = {}) {
    const ctx = createContext(request, platform);
    let response;
    try {
      response = await run(ctx, platform);
    } catch (err) {
      if (err instanceof StoreError) response = ctx.fail(503, 'store_unavailable', 'Store unavailable; request refused.');
      else if (err instanceof GatewayError) response = ctx.fail(err.status, err.code, err.message, err.headers);
      else {
        logger.exception(err, ctx);
        response = ctx.fail(500, 'internal_error', 'Internal gateway error.');
      }
    }
    return finalize(ctx, response);
  };

  /** @param {Request} request @param {{waitUntil?: (p: Promise<unknown>) => void}} platform */
  function createContext(request, platform) {
    const platformWaitUntil = platform.waitUntil ?? options.waitUntil;
    /** @type {any} */
    const ctx = {
      requestId: randomUUID(),
      request,
      url: new URL(request.url),
      method: request.method,
      params: {},
      config,
      now,
      sleep,
      instance,
      cold: instance.requests++ === 0,
      t0: performance.now(),
      timings: { auth: undefined, store: 0, upstream: undefined },
      route: null,
      source: null,
      keys: null,
      authenticated: false,
      error: null,
      redactor: baseRedactor,
      log: { provider: undefined, model: undefined, upstream_ms: undefined },
      deferLog: false,
      logged: false,
      verifyProviderKey,
      upstreamTimeoutMs,
    };
    ctx.redact = (/** @type {unknown} */ text) => ctx.redactor.scrub(text);
    ctx.waitUntil = (/** @type {Promise<unknown>} */ promise) => {
      const guarded = Promise.resolve(promise).catch((err) => logger.exception(err, ctx));
      if (platformWaitUntil) platformWaitUntil(guarded);
    };
    ctx.store = store && timed(store, ctx.timings);
    ctx.events = createEventRecorder({ store: ctx.store, waitUntil: ctx.waitUntil, scrub: ctx.redact, now, requestId: ctx.requestId });
    ctx.fail = (/** @type {number} */ status, /** @type {string} */ code, /** @type {string} */ message, headers = {}) => {
      ctx.error = { status, code, recorded: false };
      return jsonResponse(status, errorEnvelope({ message, code }), { 'x-router-error-source': 'gateway', ...headers });
    };
    ctx.finishLog = (/** @type {number} */ status) => {
      if (ctx.logged) return;
      ctx.logged = true;
      logger.request(
        {
          request_id: ctx.requestId,
          route: ctx.route,
          method: ctx.method,
          status,
          provider: ctx.log.provider,
          model: ctx.log.model,
          duration_ms: round1(performance.now() - ctx.t0),
          upstream_ms: ctx.log.upstream_ms,
          store_ms: round1(ctx.timings.store),
          error_code: ctx.error?.code,
          cold: ctx.cold,
        },
        ctx.redact,
      );
    };
    return ctx;
  }

  /** @param {any} ctx @param {{remoteAddress?: string}} platform @returns {Promise<Response>} */
  async function run(ctx, platform) {
    const path = routePath(ctx.url);
    const match = path === null ? null : matchRoute(path, ctx.method);
    if (match && 'route' in match) ctx.route = match.route.path;
    if (!isProtected(ctx.url)) return ctx.fail(404, 'not_found', 'Not found.');
    if (!configured) return ctx.fail(503, 'server_misconfigured', misconfigured);

    const presented = bearerCredential(ctx.request);
    if (presented === null) {
      return ctx.fail(401, 'missing_credentials', 'Missing credentials: send "Authorization: Bearer <password>".');
    }
    ctx.redactor = ctx.redactor.with([presented]);
    ctx.source = resolveSource(ctx.request, config, platform.remoteAddress);
    const limiter = createLimiter({ store: ctx.store, limits: config.limiter, now });

    // 1. Precheck (StoreError propagates: 503, no password evaluation).
    const pre = await limiter.precheck(ctx.source.id);
    if (!pre.allowed) {
      ctx.waitUntil(limiter.release(ctx.source.id));
      return ctx.fail(429, pre.code, REJECTIONS[pre.code], { 'retry-after': String(pre.retryAfter) });
    }
    // 2. Verify.
    const t = performance.now();
    let ok;
    try {
      ok = await /** @type {NonNullable<typeof authenticator>} */ (authenticator).check(presented);
    } catch (err) {
      ctx.waitUntil(limiter.release(ctx.source.id));
      throw err;
    } finally {
      ctx.timings.auth = performance.now() - t;
    }
    // 4. Wrong.
    if (!ok) {
      const { waitMs, blockSeconds } = await limiter.recordFailure(ctx.source.id);
      ctx.events.record({
        kind: 'auth',
        code: 'invalid_credentials',
        status: 401,
        source: ctx.source.display,
        block_seconds: blockSeconds || undefined,
      });
      const delay = Math.min(waitMs, 1000);
      if (delay > 0) await ctx.sleep(delay);
      const retryAfter = blockSeconds || Math.ceil(waitMs / 1000);
      const res = ctx.fail(401, 'invalid_credentials', 'Invalid credentials.', retryAfter > 0 ? { 'retry-after': String(retryAfter) } : {});
      ctx.error.recorded = true; // recorded above as an auth event
      return res;
    }
    // 3. Correct.
    ctx.waitUntil(limiter.release(ctx.source.id));
    ctx.authenticated = true;
    ctx.keys = keyResolver.resolve(pre.keys, (provider) =>
      ctx.events.record({
        kind: 'gateway',
        code: 'provider_key_undecryptable',
        status: 500,
        provider,
      }),
    );
    ctx.redactor = ctx.redactor.with(Object.values(ctx.keys).map((k) => k.key));

    if (!match || !('route' in match)) {
      if (match && match.status === 405) {
        return ctx.fail(405, 'method_not_allowed', 'Method not allowed.', { allow: match.allow.join(', ') });
      }
      return ctx.fail(404, 'not_found', 'Not found.');
    }
    ctx.params = match.params;
    return match.route.handler(ctx);
  }

  /** @param {any} ctx @param {Response} response */
  function finalize(ctx, response) {
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'no-store');
    headers.set('x-router-request-id', ctx.requestId);
    if (ctx.log.provider && !headers.has('x-router-provider')) headers.set('x-router-provider', ctx.log.provider); // routed requests
    if (ctx.authenticated) {
      if (ctx.cold) headers.set('x-router-cold', '1'); // the first request this instance served
      if (!headers.has('server-timing')) {
        const { auth, store: storeMs, upstream } = ctx.timings;
        headers.set('server-timing', serverTimingHeader({ auth, store: storeMs, upstream, gw: performance.now() - ctx.t0 }));
      }
    }
    if (ctx.error && ctx.authenticated && !ctx.error.recorded) {
      ctx.error.recorded = true;
      const { provider, model } = ctx.log;
      ctx.events.record({ kind: 'gateway', code: ctx.error.code, status: ctx.error.status, provider, model });
    }
    const out = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    if (!ctx.deferLog) ctx.finishLog(out.status);
    return out;
  }
}

/**
 * Wrap a store so every call adds its duration to `timings.store`.
 * @param {import('./store/index.js').Store} store
 * @param {{store: number}} timings
 * @returns {import('./store/index.js').Store}
 */
function timed(store, timings) {
  /** @type {any} */
  const out = { kind: store.kind };
  for (const name of STORE_METHODS) {
    out[name] = async (/** @type {unknown[]} */ ...args) => {
      const t = performance.now();
      try {
        return await /** @type {any} */ (store)[name](...args);
      } finally {
        timings.store += performance.now() - t;
      }
    };
  }
  return out;
}
