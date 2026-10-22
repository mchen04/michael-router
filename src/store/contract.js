// What every store implementation shares: the error type, the method list failClosed wraps, the
// limiter field lifetimes the store enforces, and the checks both implementations apply to input.

/** Statement budget: a store call slower than this (after connecting) fails closed. */
export const STORE_TIMEOUT_MS = 1500;
/** Postgres connect budget (covers a cold compute wake); also bounds waiting for a pool client. */
export const CONNECT_TIMEOUT_MS = 5000;

/** The inflight slot taken by a precheck lives this long unless released. */
export const INFLIGHT_TTL_MS = 60_000;
/** Strikes (blocks counted for escalation) live this long after the latest one. */
export const STRIKES_TTL_MS = 7 * 24 * 3600 * 1000;
/** Dead auth rows (every end time passed) removed by one authFailure call, at most. */
export const SWEEP_LIMIT = 100;

/** Every domain method of a store (failClosed and the handler's timing wrapper cover each). */
export const STORE_METHODS = Object.freeze([
  'ping',
  'authPrecheck',
  'authRelease',
  'authFailure',
  'authPenalty',
  'setProviderKey',
  'deleteProviderKey',
  'addUsage',
  'readUsage',
  'appendEvent',
  'listEvents',
]);

export class StoreError extends Error {
  /** @param {string} message @param {{sqlstate?: string}} [options] */
  constructor(message, { sqlstate } = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = 'store_unavailable';
    /** The server's 5-character SQLSTATE, when the failure came from the database. */
    this.sqlstate = typeof sqlstate === 'string' && /^[0-9A-Z]{5}$/.test(sqlstate) ? sqlstate : undefined;
  }
}

/** @param {unknown} v */
const isText = (v) => typeof v === 'string';

/**
 * @param {unknown} entries
 * @returns {{provider: string, model: string, metric: string, value: number}[]}
 */
export function checkUsageEntries(entries) {
  if (!Array.isArray(entries)) throw new TypeError('usage entries must be an array');
  for (const e of entries) {
    if (!e || !isText(e.provider) || !isText(e.model) || !isText(e.metric) || !(Number.isSafeInteger(e.value) && e.value > 0)) {
      throw new TypeError('usage entry must have provider, model, metric and a positive safe-integer value');
    }
  }
  return entries;
}

/** @param {unknown} day */
export function checkDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new TypeError('day must be YYYY-MM-DD');
  return day;
}

/** @param {unknown} n */
export function checkMs(n) {
  if (!Number.isSafeInteger(n)) throw new TypeError('time must be an integer number of milliseconds');
  return /** @type {number} */ (n);
}

/**
 * @typedef {{blockUntilMs: number | null, waitUntilMs: number | null, failures: number, inflight: number,
 *   keys: Record<string, string>}} Precheck
 * @typedef {{
 *   kind: string,
 *   ping: () => Promise<{schemaVersion: number}>,
 *   authPrecheck: (source: string, nowMs: number) => Promise<Precheck>,
 *   authRelease: (source: string, nowMs: number) => Promise<void>,
 *   authFailure: (source: string, nowMs: number, limits: {windowMs: number, maxFailures: number}) =>
 *     Promise<{failures: number, strikes: number | null}>,
 *   authPenalty: (source: string, nowMs: number, until: {waitUntilMs: number | null, blockUntilMs: number | null}) => Promise<void>,
 *   setProviderKey: (provider: string, record: string, updatedAtIso: string) => Promise<void>,
 *   deleteProviderKey: (provider: string) => Promise<boolean>,
 *   addUsage: (day: string, entries: {provider: string, model: string, metric: string, value: number}[],
 *     options: {retainFromDay: string}) => Promise<void>,
 *   readUsage: (fromDay: string, toDay: string) => Promise<{day: string, provider: string, model: string, metric: string, value: number}[]>,
 *   appendEvent: (json: string, max: number) => Promise<void>,
 *   listEvents: (max: number) => Promise<string[]>,
 *   close?: () => Promise<void>,
 * }} Store
 */
