// /control/* routes. Every handler receives the per-request ctx built by src/handler.js
// (authenticated, effective provider keys resolved). Key verification is ctx.verifyProviderKey
// (src/proxy.js by default).
import { performance } from 'node:perf_hooks';
import { PROVIDER_IDS } from './config.js';
import { EVENT_KINDS, listEvents } from './events.js';
import { GatewayError, errorEnvelope, jsonResponse, readJsonBody } from './http.js';
import { encryptProviderKey, isProviderId, publicKeyInfo, validateProviderKey } from './keys.js';
import { aggregateUsage, usageDays } from './usage.js';
import { VERSION } from './version.js';

const KEY_BODY_MAX_BYTES = 16 * 1024;

/** @param {number} ms */
const round1 = (ms) => Math.round(ms * 10) / 10;

/** @param {any} ctx */
function providerParam(ctx) {
  const provider = ctx.params.provider;
  if (!isProviderId(provider)) {
    throw new GatewayError(400, 'invalid_provider', `Unknown provider; use one of: ${PROVIDER_IDS.join(', ')}.`);
  }
  return provider;
}

/** GET /control/health @param {any} ctx */
export async function health(ctx) {
  const t = performance.now();
  const { schemaVersion } = await ctx.store.ping();
  const latency = performance.now() - t;
  const startedAt = ctx.instance.startedAt;
  return jsonResponse(200, {
    status: 'ok',
    version: VERSION,
    commit: ctx.config.commit,
    region: ctx.config.region,
    instance: { started_at: new Date(startedAt).toISOString(), age_s: Math.round((ctx.now() - startedAt) / 1000), cold: ctx.cold },
    store: { kind: ctx.store.kind, latency_ms: round1(latency), schema_version: schemaVersion },
    providers: Object.fromEntries(PROVIDER_IDS.map((id) => [id, { configured: ctx.keys[id].configured }])),
  });
}

/** GET /control/keys @param {any} ctx */
export async function listKeys(ctx) {
  return jsonResponse(200, PROVIDER_IDS.map((id) => publicKeyInfo(ctx.keys[id])));
}

/** PUT /control/keys/:provider  body {"key": "...", "verify": true} @param {any} ctx */
export async function setKey(ctx) {
  const provider = providerParam(ctx);
  const body = await readJsonBody(ctx.request, KEY_BODY_MAX_BYTES);
  const problem = validateProviderKey(body.key);
  if (problem) throw new GatewayError(400, 'invalid_key', `Invalid key: ${problem}.`);
  if (body.verify !== undefined && typeof body.verify !== 'boolean') {
    throw new GatewayError(400, 'invalid_parameter', 'verify must be a boolean.');
  }
  const key = /** @type {string} */ (body.key);
  ctx.redactor = ctx.redactor.with([key]);
  /** @type {Record<string, unknown>} */
  let verification = {};
  if (body.verify === true) {
    // Verify before storing, so a mistyped or revoked key never replaces a working one.
    /** @type {{verified: boolean | null, upstream_status?: number}} */
    let v;
    try {
      v = await ctx.verifyProviderKey(provider, key, ctx);
    } catch {
      v = { verified: null };
    }
    const status = typeof v.upstream_status === 'number' ? v.upstream_status : undefined;
    if (v.verified === false) {
      return keyNotStored(ctx, provider, 400, 'key_rejected', `The ${provider} API rejected the key (HTTP ${status}); it was not stored.`, status);
    }
    if (v.verified !== true) {
      const why = status === undefined ? 'the provider could not be reached' : `the provider answered HTTP ${status}`;
      const message = `The ${provider} key could not be verified (${why}); it was not stored. Retry later, or store it without verification.`;
      return keyNotStored(ctx, provider, 502, 'key_verification_unavailable', message, status);
    }
    verification = { verified: true, upstream_status: status };
  }
  const updated_at = new Date(ctx.now()).toISOString();
  await ctx.store.setProviderKey(provider, encryptProviderKey(ctx.config.keyEncryptionKey, provider, key, updated_at), updated_at);
  return jsonResponse(200, { provider, configured: true, source: 'store', updated_at, ...verification });
}

/**
 * The provider's answer kept a key from being stored: an upstream error (recorded as an upstream
 * event), never containing the key.
 * @param {any} ctx @param {string} provider @param {number} status @param {string} code @param {string} message
 * @param {number | undefined} upstreamStatus
 */
function keyNotStored(ctx, provider, status, code, message, upstreamStatus) {
  ctx.error = { status, code, recorded: true };
  ctx.events.record({ kind: 'upstream', code, status, upstream_status: upstreamStatus, provider });
  const envelope = errorEnvelope({ message, code, type: 'upstream_error', provider, upstream_status: upstreamStatus });
  return jsonResponse(status, envelope, { 'x-router-error-source': 'upstream' });
}

/** DELETE /control/keys/:provider — remove the override (falls back to env) @param {any} ctx */
export async function unsetKey(ctx) {
  const provider = providerParam(ctx);
  const removed = await ctx.store.deleteProviderKey(provider);
  const envKey = ctx.config.providers[provider].envKey;
  return jsonResponse(200, {
    provider,
    configured: Boolean(envKey),
    source: envKey ? 'env' : 'none',
    updated_at: null,
    removed: removed === true,
  });
}

/** GET /control/usage?days=N | ?since=YYYY-MM-DD @param {any} ctx */
export async function usage(ctx) {
  const { from, to, days } = usageDays(ctx.url.searchParams, ctx.now());
  return jsonResponse(200, { from, to, days: days.length, ...aggregateUsage(await ctx.store.readUsage(from, to)) });
}

/** GET /control/errors?limit=N&kind=auth|upstream|gateway @param {any} ctx */
export async function errors(ctx) {
  const params = ctx.url.searchParams;
  const limitParam = params.get('limit');
  const limit = limitParam === null ? 50 : /^[1-9]\d{0,2}$/.test(limitParam) ? Number(limitParam) : NaN;
  if (!(limit >= 1 && limit <= 200)) throw new GatewayError(400, 'invalid_parameter', 'limit must be an integer from 1 to 200.');
  const kind = params.get('kind');
  if (kind !== null && !EVENT_KINDS.includes(kind)) {
    throw new GatewayError(400, 'invalid_parameter', `kind must be one of: ${EVENT_KINDS.join(', ')}.`);
  }
  return jsonResponse(200, await listEvents(ctx.store, { limit, kind: kind ?? undefined }));
}
