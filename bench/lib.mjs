// Shared benchmark helpers: statistics, run metadata, child processes, a keep-alive HTTP client
// and output files. Used by bench/overhead.mjs and bench/coldstart.mjs.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------- statistics

/** Sorted copy. @param {ArrayLike<number>} values */
export const sorted = (values) => Float64Array.from(values).sort();

/**
 * Percentile with linear interpolation between closest ranks (type 7). `s` must be sorted.
 * @param {Float64Array} s @param {number} p 0..100
 */
export function pct(s, p) {
  if (s.length === 0) return NaN;
  const h = (s.length - 1) * (p / 100);
  const lo = Math.floor(h);
  return lo + 1 < s.length ? s[lo] + (h - lo) * (s[lo + 1] - s[lo]) : s[lo];
}

/** @param {number} v */
export const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

/** n, min, p50, p90, p99, max, mean (ms, 3 decimals). @param {ArrayLike<number>} values */
export function describe(values) {
  const s = sorted(values);
  let sum = 0;
  for (const v of s) sum += v;
  return {
    n: s.length,
    min: r3(s[0]),
    p50: r3(pct(s, 50)),
    p90: r3(pct(s, 90)),
    p99: r3(pct(s, 99)),
    max: r3(s[s.length - 1]),
    mean: r3(sum / s.length),
  };
}

/** Deterministic PRNG (mulberry32), so bootstrap intervals are reproducible. @param {number} seed */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile bootstrap 95% confidence interval of the median.
 * @param {ArrayLike<number>} values @param {number} [resamples] @param {number} [seed]
 * @returns {[number | null, number | null]}
 */
export function bootstrapMedianCI(values, resamples = 2000, seed = 1) {
  const n = values.length;
  if (n === 0) return [null, null];
  const random = rng(seed);
  const buf = new Float64Array(n);
  const medians = new Float64Array(resamples);
  for (let b = 0; b < resamples; b++) {
    for (let i = 0; i < n; i++) buf[i] = values[Math.floor(random() * n)];
    buf.sort();
    medians[b] = pct(buf, 50);
  }
  medians.sort();
  return [r3(pct(medians, 2.5)), r3(pct(medians, 97.5))];
}

/**
 * Overhead of `gateway` over `direct` (ms): the difference of percentiles, and the distribution of
 * paired differences (sample i of each was taken back to back) with a bootstrap CI of its median.
 * @param {ArrayLike<number>} gateway @param {ArrayLike<number>} direct @param {number} [resamples]
 */
export function overhead(gateway, direct, resamples) {
  const g = sorted(gateway);
  const d = sorted(direct);
  const n = Math.min(gateway.length, direct.length);
  const diffs = new Float64Array(n);
  for (let i = 0; i < n; i++) diffs[i] = gateway[i] - direct[i];
  const paired = describe(diffs);
  return {
    diff_of_percentiles: { p50: r3(pct(g, 50) - pct(d, 50)), p90: r3(pct(g, 90) - pct(d, 90)), p99: r3(pct(g, 99) - pct(d, 99)) },
    paired: { ...paired, p50_ci95: bootstrapMedianCI(diffs, resamples) },
  };
}

// ---------------------------------------------------------------- run metadata

/** @param {string} cmd @param {string[]} args */
function tryExec(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

/** sha256 of every file that makes up the measured build (api, src, dev, bench, package files). */
function buildDigest() {
  const hash = createHash('sha256');
  /** @param {string} rel */
  const walk = (rel) => {
    for (const e of readdirSync(path.join(ROOT, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (e.isFile()) hash.update(`${child}\0`).update(readFileSync(path.join(ROOT, child))).update('\0');
    }
  };
  for (const dir of ['api', 'src', 'dev', 'bench']) walk(dir);
  for (const f of ['package.json', 'package-lock.json', 'vercel.json']) hash.update(`${f}\0`).update(readFileSync(path.join(ROOT, f))).update('\0');
  return hash.digest('hex').slice(0, 16);
}

/** Git commit and dirty flag when the checkout has .git; else the BENCH_GIT_REV label, if set. */
function gitState() {
  const head = tryExec('git', ['rev-parse', 'HEAD']);
  if (head) {
    const status = tryExec('git', ['status', '--porcelain']) ?? '';
    return { source: 'git', head, dirty: status !== '', changed_files: status ? status.split('\n').length : 0 };
  }
  const label = process.env.BENCH_GIT_REV;
  return { source: label ? 'BENCH_GIT_REV' : 'unavailable', head: label && /^[\w.+-]{1,80}$/.test(label) ? label : null };
}

/** Load average and free memory, for before/after records. */
export function hostLoad() {
  const [one, five, fifteen] = os.loadavg().map((v) => Math.round(v * 100) / 100);
  return { at: new Date().toISOString(), loadavg: { one, five, fifteen }, free_mem_mb: Math.round(os.freemem() / 2 ** 20) };
}

/**
 * Command line (script path relative to the repository), Node version, generic host description
 * (no host or user names) and the build identity.
 * @param {string} script import.meta.url of the benchmark
 */
export function runMeta(script) {
  const cpus = os.cpus();
  return {
    command: ['node', path.relative(ROOT, fileURLToPath(script)), ...process.argv.slice(2)].join(' '),
    node: process.version,
    v8: process.versions.v8,
    host: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpu_model: cpus[0]?.model ?? null,
      cpus: cpus.length,
      total_mem_gb: Math.round(os.totalmem() / 2 ** 30),
    },
    git: gitState(),
    build_digest: buildDigest(),
    started_at: new Date().toISOString(),
    load_before: hostLoad(),
  };
}

/** @param {string} dir @param {Record<string, unknown>} files name -> JSON value or text */
export function writeOutputs(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
  }
}

// ---------------------------------------------------------------- child processes

/**
 * Spawn `node <args>` and resolve when it prints `listening on http://...`. stdout is drained
 * after that (the router logs one line per request, as it does on Vercel).
 * @param {string[]} args node arguments (script first, or node flags then the script)
 * @param {Record<string, string>} env the complete child environment
 * @param {{timeoutMs?: number}} [options]
 */
export async function startNode(args, env, { timeoutMs = 20_000 } = {}) {
  const t0 = performance.now();
  const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stderr.setEncoding('utf8').on('data', (d) => (err = (err + d).slice(-4000)));
  child.stdout.setEncoding('utf8');
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out starting ${args.join(' ')}: ${err}`)), timeoutMs);
    /** @param {string} d */
    const onData = (d) => {
      out += d;
      const m = /listening on (http:\/\/\S+)/.exec(out);
      if (!m) return;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stdout.resume();
      resolve(m[1]);
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${args.join(' ')} exited with ${code}: ${err}`));
    });
  });
  return {
    url: /** @type {string} */ (url),
    startedAt: t0,
    listeningMs: performance.now() - t0,
    child,
    stderr: () => err,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      await once(child, 'exit');
    },
  };
}

// ---------------------------------------------------------------- HTTP client

/**
 * Keep-alive node:http client. `send` resolves with headers/first-byte/total times (ms from just
 * before the request was written), status, selected headers and the body.
 * @param {number} maxSockets
 */
export function createClient(maxSockets) {
  const agent = new http.Agent({ keepAlive: true, maxSockets, keepAliveMsecs: 30_000 });
  return {
    agent,
    /**
     * @param {string} url
     * @param {{method?: string, headers?: Record<string, string>, body?: Buffer}} [o]
     * @returns {Promise<{status: number, headersMs: number, ttfbMs: number, totalMs: number, headers: http.IncomingHttpHeaders, body: string}>}
     */
    send(url, o = {}) {
      return new Promise((resolve, reject) => {
        const t0 = performance.now();
        const req = http.request(url, { method: o.method ?? 'GET', headers: o.headers, agent }, (res) => {
          const headersMs = performance.now() - t0;
          /** @type {number | undefined} */
          let ttfbMs;
          /** @type {Buffer[]} */
          const chunks = [];
          res.on('data', (c) => {
            ttfbMs ??= performance.now() - t0;
            chunks.push(c);
          });
          res.on('end', () => {
            const totalMs = performance.now() - t0;
            resolve({ status: res.statusCode ?? 0, headersMs, ttfbMs: ttfbMs ?? totalMs, totalMs, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
          });
          res.on('error', reject);
        });
        req.on('error', reject);
        req.end(o.body);
      });
    },
    close: () => agent.destroy(),
  };
}

/**
 * `server-timing` entries as numbers (ms).
 * @param {string | string[] | undefined} header
 * @returns {Record<string, number>}
 */
export function parseServerTiming(header) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const entry of String(header ?? '').split(',')) {
    const m = /^\s*([A-Za-z0-9_-]+)\s*;\s*dur=([\d.]+)/.exec(entry);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

/**
 * `--name value` / `--name=value` flags. Spec types: int (non-negative, optional min/max), ints
 * (comma-separated), string, bool. Unknown flags throw.
 * @param {string[]} argv
 * @param {Record<string, {type: 'int' | 'ints' | 'string' | 'bool', default?: any, min?: number, max?: number}>} spec
 * @returns {Record<string, any>}
 */
export function parseFlags(argv, spec) {
  /** @type {Record<string, any>} */
  const out = Object.fromEntries(Object.entries(spec).map(([k, s]) => [k, s.default]));
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const name = flag.startsWith('--') ? flag.slice(2) : '';
    const s = spec[name];
    if (!s) throw new Error(`unknown argument: ${flag}`);
    if (s.type === 'bool') {
      out[name] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (s.type === 'string') {
      out[name] = value;
      continue;
    }
    const ints = value.split(',').map(Number);
    for (const n of ints) {
      if (!Number.isInteger(n) || n < (s.min ?? 0) || n > (s.max ?? Number.MAX_SAFE_INTEGER)) {
        throw new Error(`${flag} must be ${s.type === 'ints' ? 'comma-separated integers' : 'an integer'} from ${s.min ?? 0}${s.max === undefined ? '' : ` to ${s.max}`}`);
      }
    }
    if (s.type === 'int' && ints.length !== 1) throw new Error(`${flag} takes one integer`);
    out[name] = s.type === 'int' ? ints[0] : ints;
  }
  return out;
}

/** A profile location without machine paths: repo-relative, node:internal, or the V8 pseudo-frame. @param {string} url */
function where(url) {
  if (!url) return '';
  const p = url.startsWith('file://') ? fileURLToPath(url) : url;
  return p.startsWith(ROOT) ? p.slice(ROOT.length) : p.startsWith('/') ? `(outside repo)/${path.basename(p)}` : p;
}

/** @param {string} loc */
function category(loc) {
  if (loc === '') return 'v8/native';
  if (loc.startsWith('node:')) return 'node internals';
  if (loc.includes('node_modules/')) return 'dependencies';
  if (loc.startsWith('src/') || loc.startsWith('api/')) return 'gateway (src/)';
  if (loc.startsWith('dev/')) return 'dev server adapter';
  return 'other';
}

/**
 * Self time of a V8 .cpuprofile by function and by category, as shares of busy (non-idle) time.
 * @param {string} file
 * @param {number} [top]
 */
export function summarizeCpuProfile(file, top = 30) {
  const prof = JSON.parse(readFileSync(file, 'utf8'));
  /** @type {Map<number, any>} */
  const nodes = new Map(prof.nodes.map((/** @type {any} */ n) => [n.id, n]));
  /** @type {Map<number, number>} */
  const self = new Map();
  for (let i = 0; i < prof.samples.length; i++) self.set(prof.samples[i], (self.get(prof.samples[i]) ?? 0) + (prof.timeDeltas[i] ?? 0));
  /** @type {Map<string, {fn: string, at: string, us: number}>} */
  const byFn = new Map();
  /** @type {Map<string, number>} */
  const byCategory = new Map();
  let total = 0;
  let idle = 0;
  for (const [id, us] of self) {
    const { functionName, url, lineNumber } = nodes.get(id).callFrame;
    total += us;
    if (functionName === '(idle)') {
      idle += us;
      continue;
    }
    const loc = where(url);
    const key = `${functionName}\0${loc}\0${lineNumber}`;
    const entry = byFn.get(key) ?? { fn: functionName || '(anonymous)', at: loc ? `${loc}:${lineNumber + 1}` : '', us: 0 };
    entry.us += us;
    byFn.set(key, entry);
    const cat = functionName === '(garbage collector)' ? 'garbage collector' : category(loc);
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + us);
  }
  const busy = total - idle;
  const share = (/** @type {number} */ us) => Math.round((us / busy) * 1000) / 10;
  return {
    total_ms: Math.round(total / 1000),
    busy_ms: Math.round(busy / 1000),
    by_category: [...byCategory].sort((a, b) => b[1] - a[1]).map(([name, us]) => ({ category: name, self_ms: Math.round(us / 1000), busy_pct: share(us) })),
    top_self: [...byFn.values()]
      .sort((a, b) => b.us - a.us)
      .slice(0, top)
      .map((e) => ({ fn: e.fn, at: e.at, self_ms: Math.round(e.us / 100) / 10, busy_pct: share(e.us) })),
  };
}

/** Markdown table. @param {string[]} head @param {unknown[][]} rows */
export function table(head, rows) {
  const cell = (/** @type {unknown} */ v) => (v === null || v === undefined ? '-' : String(v));
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}
