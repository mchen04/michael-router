// In-process handler harness: memory store (unless given one), captured logs and waitUntil promises.
import { createHandler } from '../../src/handler.js';
import { createMemoryStore } from '../../src/store/memory.js';
import { OFFLINE_BASE_URLS, baseEnv } from './fixtures.js';

/**
 * Provider base URLs default to a closed port unless `env` points them at a fake. `store: null`
 * lets the handler build its store from the configuration.
 * @param {{env?: Record<string, string>, clock?: {now: () => number}, store?: any, sleep?: (ms: number) => Promise<void>,
 *   verifyPassword?: any, verifyProviderKey?: any, upstreamTimeoutMs?: number, rawEnv?: boolean,
 *   attachDatabasePool?: (pool: import('pg').Pool) => void}} [options]
 */
export async function makeHarness(options = {}) {
  const now = options.clock?.now;
  const store = options.store === undefined ? createMemoryStore() : options.store;
  const env = options.rawEnv ? { ...OFFLINE_BASE_URLS, ...options.env } : await baseEnv({ ...OFFLINE_BASE_URLS, ...options.env });
  /** @type {string[]} */
  const logs = [];
  /** @type {number[]} */
  const sleeps = [];
  /** @type {Promise<unknown>[]} */
  const pending = [];
  const handler = createHandler({
    env,
    store: store ?? undefined,
    now,
    sleep:
      options.sleep ??
      (async (ms) => {
        sleeps.push(ms);
      }),
    verifyPassword: options.verifyPassword,
    verifyProviderKey: options.verifyProviderKey,
    upstreamTimeoutMs: options.upstreamTimeoutMs,
    attachDatabasePool: options.attachDatabasePool,
    logSink: (line) => logs.push(line),
    errorSink: (line) => logs.push(line),
  });
  /**
   * @param {string} path
   * @param {RequestInit} [init]
   * @param {{remoteAddress?: string}} [platform]
   */
  async function call(path, init = {}, platform = {}) {
    const res = await handler(new Request(`http://localhost${path}`, init), {
      remoteAddress: '127.0.0.1',
      waitUntil: (p) => pending.push(p),
      ...platform,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { res, status: res.status, headers: res.headers, text, json };
  }
  return {
    handler,
    store,
    logs,
    sleeps,
    call,
    /** Await background work (event writes, inflight releases). */
    async settle() {
      while (pending.length) await Promise.all(pending.splice(0));
    },
  };
}
