// Provider key resolution: store override (provider_keys, AES-256-GCM, AAD = provider id) > env > none.
import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PROVIDER_IDS, providerKeyProblem } from './config.js';

const CACHE_MAX = 32;

/**
 * @typedef {{provider: string, configured: boolean, source: 'store' | 'env' | 'none',
 *   updated_at: string | null, key: string | null}} EffectiveKey
 */

/** @param {unknown} key @returns {string | null} */
export function validateProviderKey(key) {
  return providerKeyProblem(key);
}

/** @param {unknown} id @returns {id is 'claude' | 'gemini' | 'openrouter' | 'openai'} */
export function isProviderId(id) {
  return typeof id === 'string' && /** @type {readonly string[]} */ (PROVIDER_IDS).includes(id);
}

/**
 * @param {Buffer} kek 32-byte key-encryption key (HKDF info "provider-keys-v1")
 * @param {string} provider
 * @param {string} key
 * @param {string} updatedAt ISO timestamp
 * @returns {string} JSON `{v:1, iv, ct, tag, updated_at}` (base64url fields)
 */
export function encryptProviderKey(kek, provider, key, updatedAt) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(provider, 'utf8'));
  const ct = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64url'),
    ct: ct.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    updated_at: updatedAt,
  });
}

/**
 * Throws on any malformed blob or authentication failure (wrong provider, tampering, wrong secret).
 * @param {Buffer} kek
 * @param {string} provider
 * @param {string} blob
 * @returns {{key: string, updated_at: string | null}}
 */
export function decryptProviderKey(kek, provider, blob) {
  const o = JSON.parse(blob);
  if (!o || o.v !== 1 || ![o.iv, o.ct, o.tag].every((s) => typeof s === 'string')) throw new Error('malformed key record');
  const iv = Buffer.from(o.iv, 'base64url');
  const tag = Buffer.from(o.tag, 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('malformed key record');
  const decipher = createDecipheriv('aes-256-gcm', kek, iv, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(provider, 'utf8'));
  decipher.setAuthTag(tag);
  const key = Buffer.concat([decipher.update(Buffer.from(o.ct, 'base64url')), decipher.final()]).toString('utf8');
  return { key, updated_at: typeof o.updated_at === 'string' ? o.updated_at : null };
}

/** @param {string} provider @returns {EffectiveKey} */
const none = (provider) => ({ provider, configured: false, source: 'none', updated_at: null, key: null });

/** Public view for /control/keys: never the value or a fingerprint. @param {EffectiveKey} k */
export function publicKeyInfo({ provider, configured, source, updated_at }) {
  return { provider, configured, source, updated_at };
}

/**
 * @param {{keyEncryptionKey: Buffer | null, providers: Record<string, {envKey: string | null}>}} config
 */
export function createKeyResolver(config) {
  /** Decrypted values (and failures) cached by provider + exact stored record. */
  /** @type {Map<string, {ok: true, key: string, updated_at: string | null} | {ok: false}>} */
  const cache = new Map();

  return {
    /**
     * @param {Record<string, unknown>} stored `{provider: record}` read by the precheck
     * @param {(provider: string) => void} [onUndecryptable] called once per instance per bad record
     * @returns {Record<string, EffectiveKey>}
     */
    resolve(stored, onUndecryptable) {
      /** @type {Record<string, EffectiveKey>} */
      const out = {};
      for (const id of PROVIDER_IDS) {
        if (stored && Object.hasOwn(stored, id)) {
          const blob = String(stored[id]);
          const cacheKey = `${id}\n${blob}`;
          let hit = cache.get(cacheKey);
          if (!hit) {
            try {
              if (!config.keyEncryptionKey) throw new Error('no key-encryption key');
              hit = { ok: true, ...decryptProviderKey(config.keyEncryptionKey, id, blob) };
            } catch {
              hit = { ok: false };
              onUndecryptable?.(id);
            }
            if (cache.size >= CACHE_MAX) cache.delete(/** @type {string} */ (cache.keys().next().value));
            cache.set(cacheKey, hit);
          }
          // An override that cannot be decrypted means "not configured" (no silent env fallback).
          out[id] = hit.ok ? { provider: id, configured: true, source: 'store', updated_at: hit.updated_at, key: hit.key } : none(id);
          continue;
        }
        const envKey = config.providers[id]?.envKey ?? null;
        out[id] = envKey ? { provider: id, configured: true, source: 'env', updated_at: null, key: envKey } : none(id);
      }
      return out;
    },
  };
}
