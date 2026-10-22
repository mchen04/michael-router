// Store factory. Every store is wrapped fail-closed: any error or a call slower than
// STORE_TIMEOUT_MS becomes a StoreError, which the handler turns into 503 store_unavailable.
// An unconfigured store is a configuration problem (see config.js), never a silent fallback.
import { createMemoryStore } from './memory.js';
import { createUpstashStore } from './upstash.js';

export const STORE_TIMEOUT_MS = 1500;

export class StoreError extends Error {
  /** @param {string} message @param {{cause?: unknown}} [options] */
  constructor(message, options) {
    super(message, options);
    this.name = 'StoreError';
    this.code = 'store_unavailable';
  }
}

/**
 * @typedef {{
 *   kind: string,
 *   command: (cmd: unknown[]) => Promise<any>,
 *   pipeline: (cmds: unknown[][]) => Promise<any[]>,
 *   multi: (cmds: unknown[][]) => Promise<any[]>,
 * }} Store
 */

/**
 * @param {Store} raw
 * @param {number} [timeoutMs]
 * @returns {Store}
 */
export function failClosed(raw, timeoutMs = STORE_TIMEOUT_MS) {
  /** @param {(arg: any) => Promise<any>} fn */
  const guard = (fn) => (/** @type {any} */ arg) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new StoreError('store request timed out')), timeoutMs);
      Promise.resolve()
        .then(() => fn(arg))
        .then(
          (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          (e) => {
            clearTimeout(timer);
            reject(e instanceof StoreError ? e : new StoreError(String(e?.message ?? 'store error'), { cause: e }));
          },
        );
    });
  return { kind: raw.kind, command: guard(raw.command), pipeline: guard(raw.pipeline), multi: guard(raw.multi) };
}

/**
 * @param {{kind: 'memory'} | {kind: 'upstash', url: string, token: string} | null} storeConfig
 * @param {{now?: () => number}} [options]
 * @returns {Store | null}
 */
export function createStore(storeConfig, { now } = {}) {
  if (!storeConfig) return null;
  const raw =
    storeConfig.kind === 'memory'
      ? createMemoryStore({ now })
      : createUpstashStore({ url: storeConfig.url, token: storeConfig.token, timeoutMs: STORE_TIMEOUT_MS });
  return failClosed(raw);
}
