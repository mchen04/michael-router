// In-process store with the same raw-command interface as the Upstash client, implementing
// exactly the Redis commands (and options) the router uses, with Redis semantics (TTLs, NX, types).
// dev/fake-upstash.js serves this engine over the Upstash REST protocol.

export class RedisError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'RedisError';
  }
}

const WRONGTYPE = 'WRONGTYPE Operation against a key holding the wrong kind of value';
const NOT_INT = 'ERR value is not an integer or out of range';
const SYNTAX = 'ERR syntax error';

/**
 * @typedef {{type: 'string', value: string, expiresAt: number | null}
 *   | {type: 'hash', value: Map<string, string>, expiresAt: number | null}
 *   | {type: 'list', value: string[], expiresAt: number | null}} Entry
 */

/**
 * @param {{now?: () => number}} [options]
 */
export function createMemoryStore({ now = Date.now } = {}) {
  /** @type {Map<string, Entry>} */
  const data = new Map();
  let ops = 0;

  /** @param {string} key @returns {Entry | undefined} */
  function entry(key) {
    const e = data.get(key);
    if (e && e.expiresAt !== null && e.expiresAt <= now()) {
      data.delete(key);
      return undefined;
    }
    return e;
  }
  /** @param {string} key @param {Entry['type']} type @returns {any} */
  function typed(key, type) {
    const e = entry(key);
    if (e && e.type !== type) throw new RedisError(WRONGTYPE);
    return e;
  }
  /** @param {string} s */
  function toInt(s, message = NOT_INT) {
    if (!/^-?\d{1,16}$/.test(s) || !Number.isSafeInteger(Number(s))) throw new RedisError(message);
    return Number(s);
  }
  /** @param {number} n */
  function checked(n) {
    if (!Number.isSafeInteger(n)) throw new RedisError('ERR increment or decrement would overflow');
    return n;
  }
  /** @param {string} key @param {number} by */
  function incrBy(key, by) {
    const e = typed(key, 'string');
    const next = checked((e ? toInt(e.value) : 0) + by);
    if (e) e.value = String(next);
    else data.set(key, { type: 'string', value: String(next), expiresAt: null });
    return next;
  }
  /** @param {number} len @param {string} a @param {string} b @returns {[number, number]} */
  function range(len, a, b) {
    let start = toInt(a);
    let stop = toInt(b);
    if (start < 0) start = Math.max(len + start, 0);
    if (stop < 0) stop = len + stop;
    if (stop >= len) stop = len - 1;
    return [start, stop];
  }

  /** @type {Record<string, [number, number, (args: string[]) => unknown]>} name -> [min args, max args, fn] */
  const COMMANDS = {
    PING: [0, 1, (a) => (a.length ? a[0] : 'PONG')],
    GET: [1, 1, ([k]) => typed(k, 'string')?.value ?? null],
    SET: [
      2,
      Infinity,
      ([k, v, ...opts]) => {
        /** @type {number | null} */
        let expiresAt = null;
        let nx = false;
        for (let i = 0; i < opts.length; i++) {
          const o = opts[i].toUpperCase();
          if (o === 'NX') nx = true;
          else if ((o === 'EX' || o === 'PX') && expiresAt === null && i + 1 < opts.length) {
            const n = toInt(opts[++i]);
            if (n <= 0) throw new RedisError("ERR invalid expire time in 'set' command");
            expiresAt = now() + (o === 'EX' ? n * 1000 : n);
          } else throw new RedisError(SYNTAX);
        }
        if (nx && entry(k) !== undefined) return null;
        data.set(k, { type: 'string', value: v, expiresAt });
        return 'OK';
      },
    ],
    DEL: [1, Infinity, (keys) => keys.filter((k) => entry(k) !== undefined && data.delete(k)).length],
    INCR: [1, 1, ([k]) => incrBy(k, 1)],
    DECR: [1, 1, ([k]) => incrBy(k, -1)],
    EXPIRE: [
      2,
      2,
      ([k, secs]) => {
        const n = toInt(secs);
        const e = entry(k);
        if (!e) return 0;
        if (n <= 0) data.delete(k);
        else e.expiresAt = now() + n * 1000;
        return 1;
      },
    ],
    TTL: [1, 1, ([k]) => ttl(k, 1000)],
    PTTL: [1, 1, ([k]) => ttl(k, 1)],
    HSET: [
      3,
      Infinity,
      ([k, ...fv]) => {
        if (fv.length % 2) throw new RedisError("ERR wrong number of arguments for 'hset' command");
        let e = typed(k, 'hash');
        if (!e) data.set(k, (e = { type: 'hash', value: new Map(), expiresAt: null }));
        let added = 0;
        for (let i = 0; i < fv.length; i += 2) {
          if (!e.value.has(fv[i])) added++;
          e.value.set(fv[i], fv[i + 1]);
        }
        return added;
      },
    ],
    HDEL: [
      2,
      Infinity,
      ([k, ...fields]) => {
        const e = typed(k, 'hash');
        if (!e) return 0;
        const removed = fields.filter((f) => e.value.delete(f)).length;
        if (e.value.size === 0) data.delete(k);
        return removed;
      },
    ],
    HGETALL: [1, 1, ([k]) => [...(typed(k, 'hash')?.value ?? new Map())].flat()],
    HINCRBY: [
      3,
      3,
      ([k, field, by]) => {
        const n = toInt(by);
        let e = typed(k, 'hash');
        if (!e) data.set(k, (e = { type: 'hash', value: new Map(), expiresAt: null }));
        const cur = e.value.has(field) ? toInt(e.value.get(field), 'ERR hash value is not an integer') : 0;
        const next = checked(cur + n);
        e.value.set(field, String(next));
        return next;
      },
    ],
    LPUSH: [
      2,
      Infinity,
      ([k, ...values]) => {
        let e = typed(k, 'list');
        if (!e) data.set(k, (e = { type: 'list', value: [], expiresAt: null }));
        for (const v of values) e.value.unshift(v);
        return e.value.length;
      },
    ],
    LTRIM: [
      3,
      3,
      ([k, a, b]) => {
        const e = typed(k, 'list');
        const [start, stop] = range(e ? e.value.length : 0, a, b);
        if (!e) return 'OK';
        e.value = start > stop ? [] : e.value.slice(start, stop + 1);
        if (e.value.length === 0) data.delete(k);
        return 'OK';
      },
    ],
    LRANGE: [
      3,
      3,
      ([k, a, b]) => {
        const e = typed(k, 'list');
        const [start, stop] = range(e ? e.value.length : 0, a, b);
        return !e || start > stop ? [] : e.value.slice(start, stop + 1);
      },
    ],
  };

  /** @param {string} k @param {number} unit */
  function ttl(k, unit) {
    const e = entry(k);
    if (!e) return -2;
    if (e.expiresAt === null) return -1;
    return Math.round((e.expiresAt - now()) / unit);
  }

  /**
   * Throws RedisError for malformed, unknown or wrong-arity commands (what MULTI rejects at queue time).
   * @param {unknown} cmd
   * @returns {[string, string[]]}
   */
  function validate(cmd) {
    if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((a) => typeof a === 'string' || typeof a === 'number')) {
      throw new RedisError('ERR invalid command format');
    }
    const name = String(cmd[0]).toUpperCase();
    const spec = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
    if (!spec) throw new RedisError(`ERR unknown command '${String(cmd[0]).slice(0, 64)}'`);
    const args = cmd.slice(1).map(String);
    if (args.length < spec[0] || args.length > spec[1]) {
      throw new RedisError(`ERR wrong number of arguments for '${name.toLowerCase()}' command`);
    }
    return [name, args];
  }

  /** @param {unknown} cmd */
  function exec(cmd) {
    const [name, args] = validate(cmd);
    if (++ops % 1000 === 0) for (const k of [...data.keys()]) entry(k); // sweep expired keys
    return COMMANDS[name][2](args);
  }

  /** @param {unknown[]} cmds @returns {({result: unknown} | {error: string})[]} */
  function execEach(cmds) {
    return cmds.map((c) => {
      try {
        return { result: exec(c) };
      } catch (err) {
        if (err instanceof RedisError) return { error: err.message };
        throw err;
      }
    });
  }

  /** @param {({result: unknown} | {error: string})[]} entries */
  function unwrap(entries) {
    const bad = entries.find((e) => 'error' in e);
    if (bad && 'error' in bad) throw new RedisError(bad.error);
    return entries.map((e) => ('result' in e ? e.result : null));
  }

  return {
    kind: /** @type {const} */ ('memory'),
    exec,
    validate,
    execEach,
    /** @param {unknown[]} cmd */
    command: async (cmd) => exec(cmd),
    /** @param {unknown[][]} cmds */
    pipeline: async (cmds) => unwrap(execEach(cmds)),
    /** @param {unknown[][]} cmds */
    multi: async (cmds) => {
      cmds.forEach(validate);
      return unwrap(execEach(cmds));
    },
    /** Snapshot for tests (fake-upstash `/__dump`). */
    dump() {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const k of [...data.keys()].sort()) {
        const e = entry(k);
        if (!e) continue;
        const value = e.type === 'hash' ? Object.fromEntries(e.value) : e.type === 'list' ? [...e.value] : e.value;
        out[k] = { type: e.type, value, ttl_ms: e.expiresAt === null ? -1 : e.expiresAt - now() };
      }
      return out;
    },
  };
}
