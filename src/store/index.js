// Store factory. Every store is wrapped fail-closed: any error, or a call slower than its budget,
// becomes a StoreError, which the handler turns into 503 store_unavailable without evaluating the
// password. An unconfigured store is a configuration problem (see config.js), never a silent
// fallback. The methods are the domain operations in src/store/contract.js.
import { CONNECT_TIMEOUT_MS, STORE_METHODS, STORE_TIMEOUT_MS, StoreError } from './contract.js';
import { createMemoryStore } from './memory.js';
import { createPostgresStore } from './postgres.js';

export { CONNECT_TIMEOUT_MS, STORE_METHODS, STORE_TIMEOUT_MS, StoreError };

/** @typedef {import('./contract.js').Store} Store */

/**
 * The outer budget of one call: a Postgres call may first wait up to the connect budget for a
 * client, then the statement budget (each enforced inside the store; this timer is the backstop).
 * @param {string} kind
 */
export const callBudgetMs = (kind) => (kind === 'postgres' ? CONNECT_TIMEOUT_MS + STORE_TIMEOUT_MS + 500 : STORE_TIMEOUT_MS);

/** @param {unknown} err */
const asStoreError = (err) => (err instanceof StoreError ? err : new StoreError('store request failed'));

/**
 * @param {Store} raw
 * @param {number} [timeoutMs]
 * @returns {Store}
 */
export function failClosed(raw, timeoutMs = callBudgetMs(raw.kind)) {
  /** @type {any} */
  const store = { kind: raw.kind };
  for (const name of STORE_METHODS) {
    store[name] = (/** @type {unknown[]} */ ...args) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new StoreError('store request timed out')), timeoutMs);
        Promise.resolve()
          .then(() => /** @type {any} */ (raw)[name](...args))
          .then(
            (v) => {
              clearTimeout(timer);
              resolve(v);
            },
            (e) => {
              clearTimeout(timer);
              reject(asStoreError(e));
            },
          );
      });
  }
  if (typeof raw.close === 'function') store.close = () => /** @type {() => Promise<void>} */ (raw.close)();
  return store;
}

/**
 * @param {{kind: 'memory'} | {kind: 'postgres', connectionString: string, ssl: boolean, channelBinding: boolean} | null} storeConfig
 * @param {{onPool?: (pool: import('pg').Pool) => void}} [options] onPool: Vercel's attachDatabasePool
 * @returns {Store | null}
 */
export function createStore(storeConfig, { onPool } = {}) {
  if (!storeConfig) return null;
  return failClosed(storeConfig.kind === 'memory' ? createMemoryStore() : createPostgresStore(storeConfig, { onPool }));
}
