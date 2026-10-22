// In-process store with the domain interface and the semantics of src/store/postgres.js: the same
// rows, end times from the caller's clock (a field is active while its end time is later than
// now), the same sweep. Each method runs synchronously, so each is atomic. For ROUTER_STORE=memory
// (development and tests; refused in production) and the in-process test harness.
import { INFLIGHT_TTL_MS, STRIKES_TTL_MS, SWEEP_LIMIT, checkCount, checkDay, checkMs, checkUsageEntries } from './contract.js';
import { LATEST_SCHEMA_VERSION } from './migrations.js';

/**
 * @typedef {{source: string, failures: number, failures_until_ms: number, wait_until_ms: number,
 *   block_until_ms: number, strikes: number, strikes_until_ms: number, inflight: number,
 *   inflight_until_ms: number, expires_ms: number}} AuthRow
 */

/** @param {string} source @returns {AuthRow} */
const newAuthRow = (source) => ({
  source,
  failures: 0,
  failures_until_ms: 0,
  wait_until_ms: 0,
  block_until_ms: 0,
  strikes: 0,
  strikes_until_ms: 0,
  inflight: 0,
  inflight_until_ms: 0,
  expires_ms: 0,
});

/** @param {unknown} s */
function checkText(s) {
  if (typeof s !== 'string') throw new TypeError('expected a string');
  return s;
}

export function createMemoryStore() {
  /** @type {Map<string, AuthRow>} */
  const auth = new Map();
  /** @type {Map<string, {provider: string, record: string, updated_at: string}>} */
  const keys = new Map();
  /** @type {Map<string, {day: string, provider: string, model: string, metric: string, value: number}>} */
  const usage = new Map();
  /** @type {{id: number, event: string}[]} oldest first */
  let events = [];
  let nextEventId = 1;

  /** @param {AuthRow} r @param {number} now */
  const activeInflight = (r, now) => (r.inflight_until_ms > now ? r.inflight : 0);
  /** @param {AuthRow} r @param {number} now */
  const penalized = (r, now) => Math.max(r.failures_until_ms, r.wait_until_ms, r.block_until_ms, r.strikes_until_ms) > now;

  return {
    kind: 'memory',

    async ping() {
      return { schemaVersion: LATEST_SCHEMA_VERSION };
    },

    /** @param {string} source @param {number} nowMs */
    async authPrecheck(source, nowMs) {
      checkText(source);
      const now = checkMs(nowMs);
      const r = auth.get(source) ?? newAuthRow(source);
      r.inflight = activeInflight(r, now) + 1;
      r.inflight_until_ms = now + INFLIGHT_TTL_MS;
      r.expires_ms = Math.max(r.expires_ms, r.inflight_until_ms);
      auth.set(source, r);
      return {
        blockUntilMs: r.block_until_ms > now ? r.block_until_ms : null,
        waitUntilMs: r.wait_until_ms > now ? r.wait_until_ms : null,
        failures: r.failures_until_ms > now ? r.failures : 0,
        inflight: r.inflight,
        keys: Object.fromEntries([...keys.values()].map((k) => [k.provider, k.record])),
      };
    },

    /** @param {string} source @param {number} nowMs */
    async authRelease(source, nowMs) {
      checkText(source);
      const now = checkMs(nowMs);
      const r = auth.get(source);
      if (!r) return;
      const inflight = Math.max(activeInflight(r, now) - 1, 0);
      if (inflight === 0 && !penalized(r, now)) auth.delete(source);
      else r.inflight = inflight;
    },

    /**
     * @param {string} source @param {number} nowMs
     * @param {{windowMs: number, maxFailures: number}} limits
     */
    async authFailure(source, nowMs, { windowMs, maxFailures }) {
      checkText(source);
      const now = checkMs(nowMs);
      checkMs(windowMs);
      checkMs(maxFailures);
      const r = auth.get(source) ?? newAuthRow(source);
      const windowActive = r.failures_until_ms > now;
      r.failures = windowActive ? r.failures + 1 : 1;
      if (!windowActive) r.failures_until_ms = now + windowMs;
      r.inflight = Math.max(activeInflight(r, now) - 1, 0);
      const strike = r.failures === maxFailures;
      if (strike) {
        r.strikes = (r.strikes_until_ms > now ? r.strikes : 0) + 1;
        r.strikes_until_ms = now + STRIKES_TTL_MS;
      }
      r.expires_ms = Math.max(r.expires_ms, r.failures_until_ms, r.strikes_until_ms);
      auth.set(source, r);
      // The same opportunistic sweep as Postgres: dead rows of other sources, oldest first.
      const dead = [...auth.values()].filter((d) => d.expires_ms < now && d.source !== source);
      for (const d of dead.sort((a, b) => a.expires_ms - b.expires_ms).slice(0, SWEEP_LIMIT)) auth.delete(d.source);
      return { failures: r.failures, strikes: strike ? r.strikes : null };
    },

    /**
     * @param {string} source @param {number} nowMs
     * @param {{waitUntilMs: number | null, blockUntilMs: number | null}} until
     */
    async authPenalty(source, nowMs, { waitUntilMs, blockUntilMs }) {
      checkText(source);
      checkMs(nowMs);
      if (waitUntilMs !== null) checkMs(waitUntilMs);
      if (blockUntilMs !== null) checkMs(blockUntilMs);
      if (waitUntilMs === null && blockUntilMs === null) return;
      const r = auth.get(source) ?? newAuthRow(source);
      r.wait_until_ms = Math.max(r.wait_until_ms, waitUntilMs ?? 0);
      r.block_until_ms = Math.max(r.block_until_ms, blockUntilMs ?? 0);
      r.expires_ms = Math.max(r.expires_ms, r.wait_until_ms, r.block_until_ms);
      auth.set(source, r);
    },

    /** @param {string} provider @param {string} record @param {string} updatedAtIso */
    async setProviderKey(provider, record, updatedAtIso) {
      checkText(provider);
      checkText(record);
      if (!Number.isFinite(Date.parse(checkText(updatedAtIso)))) throw new TypeError('updated_at must be a timestamp');
      keys.set(provider, { provider, record, updated_at: updatedAtIso });
    },

    /** @param {string} provider */
    async deleteProviderKey(provider) {
      return keys.delete(checkText(provider));
    },

    /**
     * @param {string} day
     * @param {{provider: string, model: string, metric: string, value: number}[]} entries
     * @param {{retainFromDay: string}} options
     */
    async addUsage(day, entries, { retainFromDay }) {
      checkDay(day);
      checkDay(retainFromDay);
      checkUsageEntries(entries);
      if (entries.length === 0) return;
      for (const [id, row] of usage) if (row.day < retainFromDay) usage.delete(id);
      for (const { provider, model, metric, value } of entries) {
        const id = JSON.stringify([day, provider, model, metric]);
        const row = usage.get(id);
        if (row) row.value += value;
        else usage.set(id, { day, provider, model, metric, value });
      }
    },

    /** @param {string} fromDay @param {string} toDay */
    async readUsage(fromDay, toDay) {
      checkDay(fromDay);
      checkDay(toDay);
      return [...usage.values()].filter((r) => r.day >= fromDay && r.day <= toDay).map((r) => ({ ...r }));
    },

    /** @param {string} json @param {number} max */
    async appendEvent(json, max) {
      JSON.parse(checkText(json)); // Postgres stores it as json, which must parse
      checkCount(max);
      events.push({ id: nextEventId++, event: json });
      if (events.length > max) events = events.slice(events.length - max);
    },

    /** @param {number} max */
    async listEvents(max) {
      checkMs(max);
      return events
        .slice(-max)
        .reverse()
        .map((e) => e.event);
    },

    /** Every row, table by table, in the Postgres column names (tests only). */
    dump() {
      return {
        auth_sources: [...auth.values()].map((r) => ({ ...r })),
        provider_keys: [...keys.values()].map((k) => ({ ...k })),
        usage_daily: [...usage.values()].map((r) => ({ ...r })),
        events: events.map((e) => ({ ...e })),
      };
    },
  };
}
