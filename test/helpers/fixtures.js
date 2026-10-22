// Invented sentinel secrets for tests. None of these is a real credential.
import { Buffer } from 'node:buffer';
import { hashPassword } from '../../src/auth.js';

export const PASSWORD = 'pw-SENTINEL-correct-horse-battery-7f3a';
export const WRONG_PASSWORD = 'pw-SENTINEL-wrong-guess-0b1c';
export const ROUTER_SECRET = Buffer.from('router-secret-SENTINEL-0123456789abcdefghijkl').toString('base64url');
export const DATABASE_PASSWORD = 'db-password-SENTINEL-5e6f7a8b9c';
export const ENV_KEYS = Object.freeze({
  ANTHROPIC_API_KEY: 'sk-ant-fake-SENTINEL-env-claude-0001',
  GEMINI_API_KEY: 'AIzaFAKE-SENTINEL-env-gemini-01',
  OPENROUTER_API_KEY: 'sk-or-fake-SENTINEL-env-openrouter-0001',
});
/** Unreachable upstreams (a closed port; https so production-mode configs accept them too): the default for every test, so nothing can reach a real provider. */
export const OFFLINE_BASE_URLS = Object.freeze({
  ANTHROPIC_BASE_URL: 'https://127.0.0.1:1',
  GEMINI_BASE_URL: 'https://127.0.0.1:1',
  OPENROUTER_BASE_URL: 'https://127.0.0.1:1',
});
/** Cheap scrypt parameters for tests (production default is logN 15). */
export const FAST_SCRYPT = Object.freeze({ logN: 10, r: 8, p: 1 });

/** @type {Map<string, Promise<string>>} */
const hashes = new Map();
/** @param {string} [password] @param {{logN: number, r: number, p: number}} [params] */
export function passwordHash(password = PASSWORD, params = FAST_SCRYPT) {
  const id = `${password}|${params.logN}|${params.r}|${params.p}`;
  if (!hashes.has(id)) hashes.set(id, hashPassword(password, params));
  return /** @type {Promise<string>} */ (hashes.get(id));
}

/** @param {string} [password] */
export const bearer = (password = PASSWORD) => ({ authorization: `Bearer ${password}` });

/** Base router env using the memory store. @param {Record<string, string>} [extra] */
export async function baseEnv(extra = {}) {
  return { ROUTER_PASSWORD_HASH: await passwordHash(), ROUTER_SECRET, ROUTER_STORE: 'memory', ...extra };
}

/** A controllable clock. @param {number} [start] */
export function fakeClock(start = Date.parse('2026-10-21T12:00:00Z')) {
  let t = start;
  return {
    now: () => t,
    /** @param {number} ms */
    advance(ms) {
      t += ms;
    },
  };
}
