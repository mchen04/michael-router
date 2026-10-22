#!/usr/bin/env node
// Cold-start benchmark (DESIGN §12). Mocked evidence: the in-process memory store, no provider calls.
//
//   node bench/coldstart.mjs --out DIR [--n 30] [--import-n 30] [--warmup 3]
//
// Fresh processes, alternating in order on every iteration:
//   hello   bench/hello-server.mjs (the node:http baseline)
//   router  dev/server.js configured like production apart from TLS and the store
//           (ROUTER_STORE=memory; scrypt logN 15 password hash, fake provider keys)
// The PostgreSQL store is not modelled: a fixed delay cannot stand in honestly for its pool,
// TLS handshake and server round trips, so there is no store-delay flag. The store path is
// measured only against a deployment (bench/live.mjs).
// For each: spawn -> "listening" line, spawn -> first successful GET /v1/models with the password,
// that first request alone, and a second request on the same connection (first-request costs
// such as scrypt show as first minus second). The router's first
// response must carry `x-router-cold: 1` and the second must not.
// Module import time: fresh `node` processes timing `await import(<module>)` for an empty module
// (the cost of the first dynamic import itself), node:http, @vercel/functions, src/handler.js and
// api/router.js, plus Node's own start-up until user code.
// --warmup iterations of each kind are run first and discarded.
//
// Writes DIR/samples.json, DIR/summary.json and DIR/summary.md (command line, Node version,
// generic host description, load averages, build identity).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { hashPassword } from '../src/auth.js';
import { ROOT, createClient, describe, hostLoad, overhead, parseFlags, parseServerTiming, r3, runMeta, startNode, table, writeOutputs } from './lib.mjs';

const SPEC = /** @type {const} */ ({
  out: { type: 'string' },
  n: { type: 'int', default: 30, min: 1 },
  'import-n': { type: 'int', default: 30, min: 1 },
  warmup: { type: 'int', default: 3 },
});
const KEYS = { ANTHROPIC_API_KEY: 'sk-ant-fake-bench-0001', GEMINI_API_KEY: 'AIzaFAKE-bench-0001' };
const IMPORTS = ['data:text/javascript,', 'node:http', '@vercel/functions', pathToFileURL(path.join(ROOT, 'src/handler.js')).href, pathToFileURL(path.join(ROOT, 'api/router.js')).href];
const IMPORT_NAMES = ['(empty module)', 'node:http', '@vercel/functions', 'src/handler.js', 'api/router.js'];
const IMPORT_PROBE = 'const t0 = performance.now(); await import(process.argv[1]); console.log(JSON.stringify({ boot_ms: t0, import_ms: performance.now() - t0 }));';

/**
 * One cold start: spawn, wait for "listening", then two GET /v1/models on one connection.
 * @param {string[]} args @param {Record<string, string>} env @param {string} password
 */
async function coldStart(args, env, password) {
  const proc = await startNode(args, env);
  const client = createClient(1);
  try {
    const headers = { authorization: `Bearer ${password}` };
    const first = await client.send(`${proc.url}/v1/models`, { headers });
    const firstResponseMs = performance.now() - proc.startedAt;
    const second = await client.send(`${proc.url}/v1/models`, { headers });
    if (first.status !== 200 || second.status !== 200) throw new Error(`${args.at(-1)}: HTTP ${first.status}/${second.status}: ${first.body.slice(0, 200)}`);
    return {
      listening_ms: proc.listeningMs,
      first_response_ms: firstResponseMs,
      first_request_ms: first.totalMs,
      second_request_ms: second.totalMs,
      cold_header: [first.headers['x-router-cold'] ?? null, second.headers['x-router-cold'] ?? null],
      server_timing: [parseServerTiming(first.headers['server-timing']), parseServerTiming(second.headers['server-timing'])],
    };
  } finally {
    client.close();
    await proc.stop();
  }
}

/** Time `await import(specifier)` in a fresh process. @param {string} specifier */
function importOnce(specifier) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, ['--input-type=module', '-e', IMPORT_PROBE, specifier], { cwd: ROOT, env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    child.on('close', (code) => {
      const wall = performance.now() - t0;
      if (code !== 0) return reject(new Error(`import ${specifier} failed (${code}): ${err.slice(0, 300)}`));
      const r = JSON.parse(out.trim().split('\n').at(-1) ?? '{}');
      resolve({ boot_ms: r.boot_ms, import_ms: r.import_ms, wall_ms: wall });
    });
  });
}

/** @param {any[]} runs @param {string} field */
const col = (runs, field) => Float64Array.from(runs, (r) => r[field]);
/** @param {Record<string, any>} o */
const roundAll = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? r3(v) : v]));

/** @param {Record<string, any>} summary */
function markdown(summary) {
  const { meta, starts, imports } = summary;
  const lines = [
    '# Cold start (in-process memory store: mocked evidence)',
    '',
    `- Command: \`${meta.command}\``,
    `- Node ${meta.node}; ${meta.host.cpus}-core ${meta.host.arch} ${meta.host.platform} ${meta.host.release}, ${meta.host.total_mem_gb} GB`,
    `- Build: ${meta.git.head ?? 'unknown'}${meta.git.dirty ? ' (uncommitted changes)' : ''}, digest ${meta.build_digest}`,
    `- Load average (1/5/15 min): before ${Object.values(meta.load_before.loadavg).join('/')}, after ${Object.values(meta.load_after.loadavg).join('/')}`,
    `- ${meta.config.n} fresh processes per kind (after ${meta.config.warmup} discarded), in-process memory store; router x-router-cold correct in ${starts.cold_header_ok} of ${meta.config.n}`,
    '',
    'Times in ms from spawn (listening, first response) or for one request.',
    '',
  ];
  const rows = [];
  for (const kind of ['hello', 'router']) {
    for (const m of ['listening_ms', 'first_response_ms', 'first_request_ms', 'second_request_ms']) {
      const d = starts[kind][m];
      rows.push([kind, m.replace(/_ms$/, ''), d.min, d.p50, d.p90, d.p99, d.max, d.mean]);
    }
  }
  lines.push(table(['process', 'measure', 'min', 'p50', 'p90', 'p99', 'max', 'mean'], rows), '');
  const cmp = Object.entries(starts.router_minus_hello).map(([m, o]) => {
    const p = /** @type {any} */ (o).paired;
    return [m.replace(/_ms$/, ''), /** @type {any} */ (o).diff_of_percentiles.p50, `${p.p50} [${p.p50_ci95.join(', ')}]`, p.p90];
  });
  lines.push('Router − hello (ms):', '', table(['measure', 'diff of p50', 'paired p50 [95% CI]', 'paired p90'], cmp), '');
  const st = starts.router_server_timing;
  lines.push(
    'Router `server-timing` medians (ms), first vs second request:',
    '',
    table(['request', 'auth', 'store', 'gw'], [
      ['first', st.first.auth.p50, st.first.store.p50, st.first.gw.p50],
      ['second', st.second.auth.p50, st.second.store.p50, st.second.gw.p50],
    ]),
    '',
  );
  lines.push(
    `Module import in a fresh process (${meta.config.import_n} each; boot = Node start-up until user code, wall = spawn to exit):`,
    '',
    table(
      ['module', 'import p50', 'import p90', 'import max', 'boot p50', 'wall p50'],
      Object.entries(imports).map(([name, d]) => [name, /** @type {any} */ (d).import_ms.p50, /** @type {any} */ (d).import_ms.p90, /** @type {any} */ (d).import_ms.max, /** @type {any} */ (d).boot_ms.p50, /** @type {any} */ (d).wall_ms.p50]),
    ),
    '',
  );
  return `${lines.join('\n')}\n`;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), SPEC);
  if (!flags.out) throw new Error('--out DIR is required');
  const out = path.resolve(flags.out);
  const meta = runMeta(import.meta.url);
  meta.config = { n: flags.n, import_n: flags['import-n'], warmup: flags.warmup, store: 'memory (in-process, not modelled)', scrypt: 'logN 15, r 8, p 1 (production default)' };
  const password = `bench-${randomBytes(18).toString('base64url')}`;
  const passwordHash = await hashPassword(password);
  const kinds = {
    hello: { args: [path.join(ROOT, 'bench/hello-server.mjs')], env: {} },
    router: {
      args: [path.join(ROOT, 'dev/server.js'), '--port', '0'],
      env: {
        ROUTER_PASSWORD_HASH: passwordHash,
        ROUTER_SECRET: randomBytes(32).toString('base64url'),
        ROUTER_STORE: 'memory',
        ...KEYS,
        ANTHROPIC_BASE_URL: 'https://127.0.0.1:1',
        GEMINI_BASE_URL: 'https://127.0.0.1:1',
        OPENROUTER_BASE_URL: 'https://127.0.0.1:1',
      },
    },
  };
  /** @type {{hello: any[], router: any[]}} */
  const runs = { hello: [], router: [] };
  /** @type {Record<string, any[]>} */
  const importRuns = Object.fromEntries(IMPORT_NAMES.map((n) => [n, []]));
  const loads = { starts_before: hostLoad(), starts_after: hostLoad(), imports_after: hostLoad() };
  process.stderr.write(`cold starts: ${flags.warmup} warm-up + ${flags.n} per kind\n`);
  for (let i = -flags.warmup; i < flags.n; i++) {
    const order = /** @type {const} */ (i % 2 === 0 ? ['hello', 'router'] : ['router', 'hello']);
    for (const kind of order) {
      const r = await coldStart(kinds[kind].args, kinds[kind].env, password);
      if (i >= 0) runs[kind].push(roundAll(r));
    }
  }
  loads.starts_after = hostLoad();
  process.stderr.write(`imports: ${flags.warmup} warm-up + ${flags['import-n']} per module\n`);
  for (let i = -flags.warmup; i < flags['import-n']; i++) {
    for (let j = 0; j < IMPORTS.length; j++) {
      const k = (j + Math.max(i, 0)) % IMPORTS.length; // rotate the order every iteration
      const r = await importOnce(IMPORTS[k]);
      if (i >= 0) importRuns[IMPORT_NAMES[k]].push(roundAll(/** @type {any} */ (r)));
    }
  }
  loads.imports_after = hostLoad();

  const measures = ['listening_ms', 'first_response_ms', 'first_request_ms', 'second_request_ms'];
  const st = (/** @type {number} */ idx) =>
    Object.fromEntries(['auth', 'store', 'gw'].map((k) => [k, describe(Float64Array.from(runs.router, (r) => r.server_timing[idx][k] ?? NaN))]));
  const starts = {
    hello: Object.fromEntries(measures.map((m) => [m, describe(col(runs.hello, m))])),
    router: Object.fromEntries(measures.map((m) => [m, describe(col(runs.router, m))])),
    router_minus_hello: Object.fromEntries(measures.map((m) => [m, overhead(col(runs.router, m), col(runs.hello, m))])),
    router_server_timing: { first: st(0), second: st(1) },
    cold_header_ok: runs.router.filter((r) => r.cold_header[0] === '1' && r.cold_header[1] === null).length,
  };
  const imports = Object.fromEntries(IMPORT_NAMES.map((n) => [n, Object.fromEntries(['import_ms', 'boot_ms', 'wall_ms'].map((m) => [m, describe(col(importRuns[n], m))]))]));
  meta.load_after = hostLoad();
  meta.loads = loads;
  meta.finished_at = new Date().toISOString();
  const summary = { meta, starts, imports };
  const md = markdown(summary);
  writeOutputs(out, { 'samples.json': { meta, starts: runs, imports: importRuns }, 'summary.json': summary, 'summary.md': md });
  process.stdout.write(md);
}

main().catch((err) => {
  console.error(`coldstart: ${err.message}`);
  process.exit(1);
});
