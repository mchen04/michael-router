// Environment parsing (frozen), defaults and the provider table. Never throws: problems are
// collected as variable names so every protected route can answer 503 server_misconfigured.
import { Buffer } from 'node:buffer';
import { hkdfSync } from 'node:crypto';
import { parsePasswordHash } from './auth.js';
import { databaseUrlSecrets, parseDatabaseUrl } from './store/database-url.js';
import { VERSION, shortCommit } from './version.js';

/** Provider ids are exactly these three; no aliases. */
export const PROVIDERS = Object.freeze({
  claude: Object.freeze({ id: 'claude', keyEnv: 'ANTHROPIC_API_KEY', baseUrlEnv: 'ANTHROPIC_BASE_URL', defaultBaseUrl: 'https://api.anthropic.com' }),
  gemini: Object.freeze({ id: 'gemini', keyEnv: 'GEMINI_API_KEY', baseUrlEnv: 'GEMINI_BASE_URL', defaultBaseUrl: 'https://generativelanguage.googleapis.com' }),
  openrouter: Object.freeze({ id: 'openrouter', keyEnv: 'OPENROUTER_API_KEY', baseUrlEnv: 'OPENROUTER_BASE_URL', defaultBaseUrl: 'https://openrouter.ai' }),
  openai: Object.freeze({ id: 'openai', keyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL', defaultBaseUrl: 'https://api.openai.com' }),
});
/** @type {readonly ('openai' | 'claude' | 'gemini' | 'openrouter')[]} */
export const PROVIDER_IDS = Object.freeze(/** @type {any} */ (Object.keys(PROVIDERS)));

/** [env name, config field, default, min, max] */
const LIMITER_VARS = [
  ['AUTH_MAX_FAILURES', 'maxFailures', 8, 1, 1000],
  ['AUTH_WINDOW_SECONDS', 'windowSeconds', 3600, 1, 604800],
  ['AUTH_BLOCK_SECONDS', 'blockSeconds', 3600, 1, 86400],
  ['AUTH_MAX_INFLIGHT', 'maxInflight', 32, 1, 10000],
  ['AUTH_BACKOFF_BASE_MS', 'backoffBaseMs', 250, 1, 600000],
  ['AUTH_BACKOFF_MAX_MS', 'backoffMaxMs', 30000, 1, 600000],
];

const STORE_VARS_NAME = 'DATABASE_URL_POOLED/DATABASE_URL';
/** The pooled URL is preferred: the router opens short-lived connections from many instances. */
const DATABASE_URL_VARS = ['DATABASE_URL_POOLED', 'DATABASE_URL'];
const PASSWORD_VARS_NAME = 'ROUTER_PASSWORD_HASH/ROUTER_PASSWORD';
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Provider keys must be 8–512 printable non-space ASCII characters.
 * @param {unknown} key
 * @returns {string | null} a message describing the problem (never containing the key), or null
 */
export function providerKeyProblem(key) {
  if (typeof key !== 'string' || key.length === 0) return 'key must be a non-empty string';
  if (key.length < 8 || key.length > 512) return 'key must be 8 to 512 characters long';
  if (/\s/.test(key)) return 'key must not contain whitespace';
  if (!/^[\x21-\x7e]+$/.test(key)) return 'key must be printable ASCII';
  return null;
}

/** @param {Record<string, string | undefined>} env @param {string} name */
function read(env, name) {
  const v = env[name];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** @param {string | undefined} value @returns {Buffer | null} */
function decodeSecret(value) {
  if (!value || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64'); // Node's decoder accepts both base64 and base64url
  return bytes.length >= 32 ? bytes : null;
}

/** @param {string | undefined} value @param {boolean} production @returns {string | null} */
function parseOrigin(value, production) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && (production || url.protocol !== 'http:')) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** Freeze plain objects/arrays recursively; Buffers are left as is. @template T @param {T} o @returns {T} */
function freeze(o) {
  if (o && typeof o === 'object' && !Buffer.isBuffer(o)) {
    for (const v of Object.values(o)) freeze(v);
    Object.freeze(o);
  }
  return o;
}

/**
 * @param {Record<string, string | undefined>} env
 */
export function loadConfig(env = {}) {
  /** @type {string[]} */
  const problems = [];
  const production = Boolean(read(env, 'VERCEL')) || env.NODE_ENV === 'production';

  // Exactly one of ROUTER_PASSWORD_HASH (preferred) or ROUTER_PASSWORD (plaintext, >= 12 chars).
  // A value piped into `vercel env add` may keep its line ending: exactly one is dropped.
  const passwordHashRaw = read(env, 'ROUTER_PASSWORD_HASH')?.replace(/\r?\n$/, '');
  const passwordRaw = read(env, 'ROUTER_PASSWORD')?.replace(/\r?\n$/, '');
  let passwordHash = null;
  let password = null;
  let passwordConflict = false;
  if (passwordHashRaw !== undefined && passwordRaw !== undefined) {
    passwordConflict = true;
    problems.push('ROUTER_PASSWORD_HASH', 'ROUTER_PASSWORD');
  } else if (passwordRaw !== undefined) {
    if (passwordRaw.length >= MIN_PASSWORD_LENGTH) password = passwordRaw;
    else problems.push('ROUTER_PASSWORD');
  } else {
    passwordHash = parsePasswordHash(passwordHashRaw);
    if (!passwordHash) problems.push(passwordHashRaw === undefined ? PASSWORD_VARS_NAME : 'ROUTER_PASSWORD_HASH');
  }

  const adminHashRaw = read(env, 'ROUTER_ADMIN_PASSWORD_HASH')?.replace(/\r?\n$/, '');
  const adminRaw = read(env, 'ROUTER_ADMIN_PASSWORD')?.replace(/\r?\n$/, '');
  const adminProblems = [];
  let adminPasswordHash = null;
  let adminPassword = null;
  if (adminHashRaw !== undefined && adminRaw !== undefined) {
    adminProblems.push('ROUTER_ADMIN_PASSWORD_HASH', 'ROUTER_ADMIN_PASSWORD');
  } else if (adminRaw !== undefined) {
    if (adminRaw.length >= MIN_PASSWORD_LENGTH) adminPassword = adminRaw;
    else adminProblems.push('ROUTER_ADMIN_PASSWORD');
  } else {
    adminPasswordHash = parsePasswordHash(adminHashRaw);
    if (!adminPasswordHash) adminProblems.push(adminHashRaw === undefined ? 'ROUTER_ADMIN_PASSWORD_HASH/ROUTER_ADMIN_PASSWORD' : 'ROUTER_ADMIN_PASSWORD_HASH');
  }

  const secretRaw = read(env, 'ROUTER_SECRET');
  const secret = decodeSecret(secretRaw);
  if (!secret) problems.push('ROUTER_SECRET');
  const derive = (/** @type {string} */ info) => (secret ? Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, 32)) : null);

  // Store: explicit ROUTER_STORE=memory (never in production) or a PostgreSQL URL.
  /** @type {{kind: 'memory'} | {kind: 'postgres', envName: string, connectionString: string, ssl: boolean, channelBinding: boolean} | null} */
  let store = null;
  const storeMode = read(env, 'ROUTER_STORE');
  const urlVar = DATABASE_URL_VARS.find((name) => read(env, name));
  if (storeMode !== undefined) {
    if (storeMode !== 'memory' || production) problems.push('ROUTER_STORE');
    else store = { kind: 'memory' };
  } else if (urlVar) {
    const db = parseDatabaseUrl(/** @type {string} */ (read(env, urlVar)), { production });
    if (db) store = { kind: 'postgres', envName: urlVar, ...db };
    else problems.push(urlVar);
  } else {
    problems.push(STORE_VARS_NAME);
  }

  /** @type {Record<string, number>} */
  const limiter = {};
  for (const [name, field, def, min, max] of /** @type {[string, string, number, number, number][]} */ (LIMITER_VARS)) {
    const raw = read(env, name);
    const n = raw === undefined ? def : /^\d{1,9}$/.test(raw) ? Number(raw) : NaN;
    const ok = n >= min && n <= max;
    if (!ok) problems.push(name);
    limiter[field] = ok ? n : def;
  }

  /** @type {Record<string, {id: string, keyEnv: string, envKey: string | null, fallbackKey: string | null, baseUrl: string}>} */
  const providers = {};
  for (const id of PROVIDER_IDS) {
    const p = PROVIDERS[id];
    const envKey = read(env, p.keyEnv) ?? null;
    if (envKey !== null && providerKeyProblem(envKey)) problems.push(p.keyEnv);
    const fallbackKey = read(env, `${p.keyEnv}_2`) ?? null;
    if (fallbackKey !== null && providerKeyProblem(fallbackKey)) problems.push(`${p.keyEnv}_2`);
    const override = read(env, p.baseUrlEnv);
    const baseUrl = override === undefined ? p.defaultBaseUrl : parseOrigin(override, production);
    if (baseUrl === null) problems.push(p.baseUrlEnv);
    providers[id] = { id, keyEnv: p.keyEnv, envKey, fallbackKey, baseUrl: baseUrl ?? p.defaultBaseUrl };
  }

  const trust = read(env, 'TRUST_PROXY_HEADERS');
  // Configured secret values the redactor always scrubs.
  const secrets = [
    adminHashRaw,
    adminRaw,
    passwordHashRaw,
    passwordRaw,
    secretRaw,
    ...DATABASE_URL_VARS.flatMap((name) => databaseUrlSecrets(read(env, name))),
    ...PROVIDER_IDS.flatMap((id) => [providers[id].envKey, providers[id].fallbackKey]),
  ].filter((v) => typeof v === 'string');

  return freeze({
    production,
    problems,
    passwordConflict,
    adminProblems,
    adminPasswordHash,
    adminPassword,
    passwordHash,
    password,
    keyEncryptionKey: derive('provider-keys-v1'),
    sourceKey: derive('source-id-v1'),
    store,
    limiter,
    providers,
    trustProxyHeaders: Boolean(read(env, 'VERCEL')) || trust === '1' || trust === 'true',
    region: read(env, 'VERCEL_REGION') ?? null,
    version: VERSION,
    commit: shortCommit(read(env, 'VERCEL_GIT_COMMIT_SHA')),
    secrets,
  });
}
