// Password hash creation/verification (scrypt) and the per-instance verified-credential cache.
import { Buffer } from 'node:buffer';
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** Defaults used by `hashPassword` (and so by `mrouter hash-password`). 32 MiB per evaluation. */
export const DEFAULT_SCRYPT = Object.freeze({ logN: 15, r: 8, p: 1 });

const BOUNDS = { logN: [10, 17], r: [1, 16], p: [1, 4] };
const MAX_SCRYPT_MEMORY = 256 * 1024 * 1024; // 128 * N * r must stay below this
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const B64URL = /^[A-Za-z0-9_-]+$/;
const CACHE_SIZE = 4;

/**
 * @typedef {{logN: number, r: number, p: number, salt: Buffer, hash: Buffer}} PasswordHash
 */

/** @param {{logN: number, r: number, p: number}} params */
function paramsOk({ logN, r, p }) {
  const inRange = (/** @type {number} */ v, /** @type {number[]} */ [lo, hi]) => Number.isInteger(v) && v >= lo && v <= hi;
  return inRange(logN, BOUNDS.logN) && inRange(r, BOUNDS.r) && inRange(p, BOUNDS.p) && 128 * 2 ** logN * r <= MAX_SCRYPT_MEMORY;
}

/**
 * Parse `scrypt$<logN>$<r>$<p>$<salt b64url>$<hash b64url>`.
 * @param {unknown} value
 * @returns {PasswordHash | null} null when missing or malformed
 */
export function parsePasswordHash(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, n, r, p, salt, hash] = parts;
  if (![n, r, p].every((s) => /^[1-9]\d{0,2}$/.test(s))) return null;
  const params = { logN: Number(n), r: Number(r), p: Number(p) };
  if (!paramsOk(params) || !B64URL.test(salt) || !B64URL.test(hash)) return null;
  const saltBuf = Buffer.from(salt, 'base64url');
  const hashBuf = Buffer.from(hash, 'base64url');
  if (saltBuf.length < SALT_BYTES || hashBuf.length < 32 || hashBuf.length > 64) return null;
  return { ...params, salt: saltBuf, hash: hashBuf };
}

/**
 * @param {string} password
 * @param {Buffer} salt
 * @param {number} keylen
 * @param {{logN: number, r: number, p: number}} params
 * @returns {Promise<Buffer>}
 */
function derive(password, salt, keylen, { logN, r, p }) {
  const N = 2 ** logN;
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N, r, p, maxmem: 128 * r * (N + p + 2) + 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/**
 * Create a `ROUTER_PASSWORD_HASH` value. Shared by the CLI (`mrouter hash-password`) and tests.
 * @param {string} password
 * @param {{logN: number, r: number, p: number}} [params]
 * @returns {Promise<string>}
 */
export async function hashPassword(password, params = DEFAULT_SCRYPT) {
  if (typeof password !== 'string' || password.length === 0) throw new TypeError('password must be a non-empty string');
  if (!paramsOk(params)) throw new RangeError('scrypt parameters out of range');
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, HASH_BYTES, params);
  return ['scrypt', params.logN, params.r, params.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

/**
 * Constant-time scrypt verification against a parsed hash.
 * @param {PasswordHash} parsed
 * @param {string} presented
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(parsed, presented) {
  const derived = await derive(presented, parsed.salt, parsed.hash.length, parsed);
  return timingSafeEqual(derived, parsed.hash);
}

/**
 * Per-instance authenticator. Credentials that verified correctly are remembered as
 * HMAC(instance-random-key, presented) — at most 4 entries; wrong credentials are never cached.
 * The cache only skips scrypt; the limiter precheck still runs on every request.
 * With a plaintext `password` (ROUTER_PASSWORD) the check compares HMAC(instance-random-key, ·)
 * digests of the presented and configured values with timingSafeEqual (fixed length, so neither
 * the length nor a prefix of the password leaks through timing).
 * @param {{passwordHash?: PasswordHash | null, password?: string | null, verifyPassword?: typeof verifyPassword}} options
 */
export function createAuthenticator({ passwordHash = null, password = null, verifyPassword: verify = verifyPassword }) {
  if (!passwordHash === !password) throw new TypeError('exactly one of passwordHash or password is required');
  const cacheKey = randomBytes(32);
  const digest = (/** @type {string} */ value) => createHmac('sha256', cacheKey).update(value).digest();
  const configured = password ? digest(password) : null;
  /** @type {string[]} */
  const verified = [];
  return {
    /** @param {string} presented */
    async check(presented) {
      const presentedDigest = digest(presented);
      const tag = presentedDigest.toString('base64url');
      if (verified.includes(tag)) return true;
      const ok = configured
        ? timingSafeEqual(presentedDigest, configured)
        : await verify(/** @type {PasswordHash} */ (passwordHash), presented);
      if (ok) {
        verified.push(tag);
        if (verified.length > CACHE_SIZE) verified.shift();
      }
      return ok;
    },
  };
}

/**
 * `Authorization: Bearer <password>` only. Anything else counts as no credential.
 * @param {Request} request
 * @returns {string | null}
 */
export function bearerCredential(request) {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer +(.+)$/i.exec(header);
  const value = match ? match[1].trim() : '';
  return value === '' ? null : value;
}
