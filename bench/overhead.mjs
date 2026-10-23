#!/usr/bin/env node
// Gateway overhead benchmark (DESIGN §12). Mocked evidence: a local fake upstream and the
// in-process memory store, never a real provider or store.
//
//   node bench/overhead.mjs --out DIR [--n 1000] [--n-concurrent 2000]
//        [--warmup 100] [--concurrency 8] [--upstream-delay-ms 0] [--chunks 8] [--interval-ms 1]
//        [--resamples 2000] [--cpu-prof]
//
// Processes: bench/fake-upstream.mjs and one dev/server.js configured like production apart from
// TLS and the store (ROUTER_STORE=memory): a scrypt password hash with the production parameters
// (logN 15), fake provider keys, all generated per run. This process is the client (node:http
// keep-alive). The PostgreSQL store is not modelled: a fixed delay cannot stand in honestly for
// its pool, TLS handshake and server round trips, so there is no store-delay flag. The store path
// is measured only against a deployment (bench/live.mjs).
//
// Targets, taken back to back in every iteration (ABBA order, reversed on odd iterations, so
// drift cancels within each pair):
//   direct_openai     client -> fake /v1beta/openai/chat/completions
//   gw_gemini         client -> router -> same (gemini pass-through)
//   direct_anthropic  client -> fake /v1/messages, with the body the Claude adapter sends
//   gw_claude         client -> router -> same (Claude adapter)
// Phases: sequential (--n after --warmup iterations) and --concurrency workers (--n-concurrent),
// each non-streaming and streaming.
// Overhead = gateway - direct, as the difference of percentiles and as the distribution of
// paired differences (with a bootstrap 95% CI of its median).
//
// Writes DIR/samples.json (raw per-iteration samples), DIR/summary.json and DIR/summary.md (with
// the command line, Node version, generic host description, load averages and the build
// identity). --cpu-prof runs the routers under `node --cpu-prof` and adds DIR/cpu-prof/ plus a
// self-time summary (profiling slows the router: use it for a separate run, not for timings).
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { hashPassword } from '../src/auth.js';
import { SMOKE_PROMPT } from '../cli/lib/commands.js';
import {
  ROOT,
  createClient,
  describe,
  hostLoad,
  overhead,
  parseFlags,
  parseServerTiming,
  r3,
  runMeta,
  startNode,
  summarizeCpuProfile,
  table,
  writeOutputs,
} from './lib.mjs';

const SPEC = /** @type {const} */ ({
  out: { type: 'string' },
  n: { type: 'int', default: 1000, min: 1 },
  'n-concurrent': { type: 'int', default: 2000, min: 1 },
  warmup: { type: 'int', default: 100 },
  concurrency: { type: 'int', default: 8, min: 2, max: 64 },
  'upstream-delay-ms': { type: 'int', default: 0, max: 60_000 },
  chunks: { type: 'int', default: 8, min: 1, max: 1000 },
  'interval-ms': { type: 'int', default: 1, max: 1000 },
  resamples: { type: 'int', default: 2000, min: 100 },
  'cpu-prof': { type: 'bool', default: false },
});
const TARGETS = /** @type {const} */ (['direct_openai', 'gw_gemini', 'direct_anthropic', 'gw_claude']);
const PAIRS = /** @type {const} */ ([
  ['gemini', 'gw_gemini', 'direct_openai'],
  ['claude', 'gw_claude', 'direct_anthropic'],
]);
const MODELS = { gemini: 'gemini-2.5-flash-lite', claude: 'claude-haiku-5-5' };
const KEYS = { ANTHROPIC_API_KEY: 'sk-ant-fake-bench-0001', GEMINI_API_KEY: 'AIzaFAKE-bench-0001' };
const MAX_TOKENS = 16;

/** @typedef {'direct_openai' | 'gw_gemini' | 'direct_anthropic' | 'gw_claude'} Target */

/**
 * The four requests of one mode, serialized once.
 * @param {{upstream: string, router: string, password: string, stream: boolean}} o
 * @returns {Record<Target, {url: string, headers: Record<string, string>, body: Buffer, check: (body: string) => boolean}>}
 */
function requests({ upstream, router, password, stream }) {
  const messages = [{ role: 'user', content: SMOKE_PROMPT }];
  const streamFields = stream ? { stream: true, stream_options: { include_usage: true } } : {};
  const openai = (/** @type {string} */ model) => ({ model, messages, max_tokens: MAX_TOKENS, ...streamFields });
  // What the Claude adapter sends upstream for gw_claude's body.
  const anthropic = { model: MODELS.claude, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: [{ type: 'text', text: SMOKE_PROMPT }] }], ...(stream ? { stream: true } : {}), cache_control: { type: 'ephemeral' } };
  const done = (/** @type {string} */ b) => (stream ? b.endsWith('data: [DONE]\n\n') : b.includes('"choices"'));
  /** @param {string} url @param {Record<string, string>} auth @param {unknown} json @param {(b: string) => boolean} check */
  const req = (url, auth, json, check) => {
    const body = Buffer.from(JSON.stringify(json));
    return { url, headers: { 'content-type': 'application/json', 'content-length': String(body.length), ...auth }, body, check };
  };
  const gateway = { authorization: `Bearer ${password}` };
  return {
    direct_openai: req(`${upstream}/v1beta/openai/chat/completions`, { authorization: `Bearer ${KEYS.GEMINI_API_KEY}` }, openai(MODELS.gemini), done),
    gw_gemini: req(`${router}/v1/chat/completions`, gateway, openai(MODELS.gemini), done),
    direct_anthropic: req(
      `${upstream}/v1/messages`,
      { 'x-api-key': KEYS.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      anthropic,
      (b) => (stream ? b.includes('event: message_stop') : b.includes('"type":"message"')),
    ),
    gw_claude: req(`${router}/v1/chat/completions`, gateway, openai(MODELS.claude), done),
  };
}

/**
 * Run `iterations` iterations over `workers` workers; each iteration sends the four targets back to
 * back (ABBA order). Returns per-target sample arrays aligned by iteration.
 * @param {ReturnType<typeof createClient>} client
 * @param {ReturnType<typeof requests>} reqs
 * @param {number} iterations @param {number} workers
 */
async function runIterations(client, reqs, iterations, workers) {
  /** @type {Record<string, Record<string, Float64Array>>} */
  const samples = {};
  for (const t of TARGETS) {
    samples[t] = { total: new Float64Array(iterations), ttfb: new Float64Array(iterations), headers: new Float64Array(iterations) };
    if (t.startsWith('gw_')) Object.assign(samples[t], { st_gw: new Float64Array(iterations), st_upstream: new Float64Array(iterations), st_store: new Float64Array(iterations), st_auth: new Float64Array(iterations) });
  }
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < iterations; i = next++) {
      const order = i % 2 === 0 ? TARGETS : [...TARGETS].reverse();
      for (const t of order) {
        const r = reqs[t];
        const res = await client.send(r.url, { method: 'POST', headers: r.headers, body: r.body });
        if (res.status !== 200 || !r.check(res.body)) {
          throw new Error(`${t}: unexpected response (HTTP ${res.status}): ${res.body.slice(0, 300)}`);
        }
        const s = samples[t];
        s.total[i] = res.totalMs;
        s.ttfb[i] = res.ttfbMs;
        s.headers[i] = res.headersMs;
        if (s.st_gw) {
          const st = parseServerTiming(res.headers['server-timing']);
          s.st_gw[i] = st.gw;
          s.st_upstream[i] = st.upstream;
          s.st_store[i] = st.store;
          s.st_auth[i] = st.auth;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: workers }, worker));
  return samples;
}

/** @param {Float64Array} a @param {Float64Array} b */
const minus = (a, b) => a.map((v, i) => v - b[i]);
/** @param {Float64Array} a */
const rounded = (a) => Array.from(a, (v) => r3(v));

/**
 * @param {Record<string, any>} block
 * @param {Record<string, Record<string, Float64Array>>} s
 * @param {number} resamples
 */
function summarizeBlock(block, s, resamples) {
  const metrics = block.mode === 'stream' ? ['ttfb', 'total'] : ['total'];
  /** @type {Record<string, any>} */
  const targets = {};
  for (const t of TARGETS) {
    targets[t] = Object.fromEntries(metrics.map((m) => [m, describe(s[t][m])]));
    if (s[t].st_gw) {
      targets[t].server_timing = {
        gw: describe(s[t].st_gw),
        upstream: describe(s[t].st_upstream),
        gw_minus_upstream: describe(minus(s[t].st_gw, s[t].st_upstream)),
        store: describe(s[t].st_store),
        auth: describe(s[t].st_auth),
      };
    }
  }
  /** @type {Record<string, any>} */
  const over = {};
  for (const [route, gw, direct] of PAIRS) over[route] = Object.fromEntries(metrics.map((m) => [m, overhead(s[gw][m], s[direct][m], resamples)]));
  return { ...block, targets, overhead: over };
}

/** @param {Record<string, any>} summary */
function markdown(summary) {
  const { meta } = summary;
  const lines = [
    '# Gateway overhead (local fakes: mocked evidence)',
    '',
    `- Command: \`${meta.command}\``,
    `- Node ${meta.node}; ${meta.host.cpus}-core ${meta.host.arch} ${meta.host.platform} ${meta.host.release}, ${meta.host.total_mem_gb} GB`,
    `- Build: ${meta.git.head ?? 'unknown'}${meta.git.dirty ? ' (uncommitted changes)' : ''}, digest ${meta.build_digest}`,
    `- Load average (1/5/15 min): before ${Object.values(meta.load_before.loadavg).join('/')}, after ${Object.values(meta.load_after.loadavg).join('/')}`,
    `- Fake upstream: ${meta.config.upstream_delay_ms} ms before headers; streams ${meta.config.chunks} text deltas ${meta.config.interval_ms} ms apart`,
    `- Iterations: sequential ${meta.config.n}, concurrency ${meta.config.concurrency} ${meta.config.n_concurrent}, after ${meta.config.warmup} warm-up iterations each`,
    '',
    'Overhead = gateway − direct in ms. "diff" = difference of the percentiles of the two distributions;',
    '"paired" = percentiles of the per-iteration differences (median with bootstrap 95% CI).',
    '',
  ];
  const rows = [];
  for (const b of summary.blocks) {
    for (const [route, gw, direct] of PAIRS) {
      for (const [metric, o] of Object.entries(b.overhead[route])) {
        const p = /** @type {any} */ (o).paired;
        rows.push([
          `${b.phase} ${b.mode}`,
          route,
          metric,
          b.targets[direct][metric].p50,
          b.targets[gw][metric].p50,
          /** @type {any} */ (o).diff_of_percentiles.p50,
          /** @type {any} */ (o).diff_of_percentiles.p90,
          /** @type {any} */ (o).diff_of_percentiles.p99,
          `${p.p50} [${p.p50_ci95.join(', ')}]`,
          p.p90,
          p.p99,
        ]);
      }
    }
  }
  lines.push(table(['phase', 'route', 'metric', 'direct p50', 'gateway p50', 'diff p50', 'diff p90', 'diff p99', 'paired p50 [95% CI]', 'paired p90', 'paired p99'], rows), '');
  lines.push('Router `server-timing` medians (ms): gw − upstream is the time the router adds before the first byte.', '');
  const st = [];
  for (const b of summary.blocks) {
    for (const [route, gw] of PAIRS) {
      const t = b.targets[gw].server_timing;
      st.push([`${b.phase} ${b.mode}`, route, t.gw.p50, t.upstream.p50, t.gw_minus_upstream.p50, t.gw_minus_upstream.p90, t.gw_minus_upstream.p99, t.store.p50, t.auth.p50]);
    }
  }
  lines.push(table(['phase', 'route', 'gw', 'upstream', 'gw−upstream p50', 'p90', 'p99', 'store', 'auth'], st), '');
  lines.push('Blocks (wall time, requests per second over all four targets, load average 1 min before/after):', '');
  lines.push(table(['phase', 'wall s', 'req/s', 'load before', 'load after'], summary.blocks.map((/** @type {any} */ b) => [`${b.phase} ${b.mode}`, b.wall_s, b.req_per_s, b.load_before.loadavg.one, b.load_after.loadavg.one])), '');
  if (summary.profiles) {
    for (const p of summary.profiles) {
      lines.push(`## CPU profile, router (busy ${p.busy_ms} of ${p.total_ms} ms)`, '');
      lines.push(table(['category', 'self ms', '% of busy'], p.by_category.map((/** @type {any} */ c) => [c.category, c.self_ms, c.busy_pct])), '');
      lines.push(table(['function', 'location', 'self ms', '% of busy'], p.top_self.map((/** @type {any} */ f) => [f.fn, f.at, f.self_ms, f.busy_pct])), '');
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2), SPEC);
  if (!flags.out) throw new Error('--out DIR is required');
  const out = path.resolve(flags.out);
  const meta = runMeta(import.meta.url);
  const config = {
    n: flags.n,
    n_concurrent: flags['n-concurrent'],
    warmup: flags.warmup,
    concurrency: flags.concurrency,
    upstream_delay_ms: flags['upstream-delay-ms'],
    chunks: flags.chunks,
    interval_ms: flags['interval-ms'],
    resamples: flags.resamples,
    cpu_prof: flags['cpu-prof'],
    store: 'memory (in-process, not modelled)',
    scrypt: 'logN 15, r 8, p 1 (production default)',
  };
  // Per-run secrets; none is ever written out.
  const password = `bench-${randomBytes(18).toString('base64url')}`;
  const passwordHash = await hashPassword(password);
  const routerSecret = randomBytes(32).toString('base64url');
  const profDir = path.join(out, 'cpu-prof');

  const upstream = await startNode(
    [path.join(ROOT, 'bench/fake-upstream.mjs'), '--port', '0', '--delay-ms', String(config.upstream_delay_ms), '--chunks', String(config.chunks), '--interval-ms', String(config.interval_ms)],
    {},
  );
  /** @type {Awaited<ReturnType<typeof startNode>>[]} */
  const procs = [upstream];
  const client = createClient(config.concurrency);
  /** @type {any[]} */
  const blocks = [];
  /** @type {Record<string, any>[]} */
  const rawBlocks = [];
  try {
    const nodeFlags = config.cpu_prof ? ['--cpu-prof', '--cpu-prof-dir', profDir] : [];
    const router = await startNode([...nodeFlags, path.join(ROOT, 'dev/server.js'), '--port', '0'], {
      ROUTER_PASSWORD_HASH: passwordHash,
      ROUTER_SECRET: routerSecret,
      ROUTER_STORE: 'memory',
      ...KEYS,
      ANTHROPIC_BASE_URL: upstream.url,
      GEMINI_BASE_URL: upstream.url,
      OPENROUTER_BASE_URL: 'https://127.0.0.1:1',
    });
    procs.push(router);
    const health = await client.send(`${router.url}/control/health`, { headers: { authorization: `Bearer ${password}` } });
    if (health.status !== 200) throw new Error(`router health check failed (HTTP ${health.status})`);

    const phases = [
      { phase: 'sequential', workers: 1, n: config.n, mode: 'nonstream' },
      { phase: 'sequential', workers: 1, n: config.n, mode: 'stream' },
      { phase: `concurrency-${config.concurrency}`, workers: config.concurrency, n: config.n_concurrent, mode: 'nonstream' },
      { phase: `concurrency-${config.concurrency}`, workers: config.concurrency, n: config.n_concurrent, mode: 'stream' },
    ];
    for (const ph of phases) {
      const reqs = requests({ upstream: upstream.url, router: router.url, password, stream: ph.mode === 'stream' });
      const block = { phase: ph.phase, mode: ph.mode, concurrency: ph.workers, n: ph.n, load_before: hostLoad() };
      process.stderr.write(`${ph.phase} ${ph.mode}: warm-up ${config.warmup}, then ${ph.n} iterations\n`);
      if (config.warmup) await runIterations(client, reqs, config.warmup, ph.workers);
      const t0 = performance.now();
      const s = await runIterations(client, reqs, ph.n, ph.workers);
      const wall = (performance.now() - t0) / 1000;
      Object.assign(block, { wall_s: Math.round(wall * 10) / 10, req_per_s: Math.round((ph.n * TARGETS.length) / wall), load_after: hostLoad() });
      blocks.push(summarizeBlock(block, s, config.resamples));
      rawBlocks.push({ ...block, samples: Object.fromEntries(Object.entries(s).map(([t, m]) => [t, Object.fromEntries(Object.entries(m).map(([k, v]) => [k, rounded(v)]))])) });
    }
  } finally {
    client.close();
    for (const p of procs.reverse()) await p.stop();
  }

  meta.load_after = hostLoad();
  meta.finished_at = new Date().toISOString();
  meta.config = config;
  /** @type {Record<string, any>} */
  const summary = { meta, blocks };
  if (config.cpu_prof) {
    summary.profiles = readdirSync(profDir)
      .filter((f) => f.endsWith('.cpuprofile'))
      .map((f) => ({ file: path.relative(out, path.join(profDir, f)), ...summarizeCpuProfile(path.join(profDir, f)) }));
  }
  const md = markdown(summary);
  writeOutputs(out, { 'samples.json': { meta, blocks: rawBlocks }, 'summary.json': summary, 'summary.md': md });
  process.stdout.write(md);
}

main().catch((err) => {
  console.error(`overhead: ${err.message}`);
  process.exit(1);
});
