#!/usr/bin/env node
// Live latency sample against a deployed Michael Router (docs/DEPLOY.md step 7).
//
//   node bench/live.mjs --url https://<host> [--n 10] [--health-n 20] [--gap-ms 2000]
//                       [--providers claude,gemini,openrouter] [--out evidence/speed/live/<stamp>.json]
//
// The router password comes from MROUTER_PASSWORD, else from stdin (piped) or a hidden prompt.
// It is sent only to the --url origin, no request follows a redirect, and it is never printed or
// written: every progress line and the evidence are checked for it first.
//
// Sends, one at a time and at least --gap-ms apart (2000 ms or more unless the target is
// loopback): --health-n GET /control/health (the first one decides whether the router is usable
// and which providers are configured) and, interleaved, --n non-streaming chat completions per
// configured provider with a tiny prompt on its smoke model (src/pricing.json `smoke_models`,
// max_tokens 16). --n above 30 is refused: this samples latency, it does not load-test real
// provider accounts.
//
// Per request it records only: kind, provider, model, HTTP status, result, client TTFB and total
// time, the router's server-timing (auth, store, upstream, gw) and x-router-cold. Derived:
// overhead = client total − upstream (the router plus the network between client and router),
// in-router = gw − upstream; provider latency (upstream) is reported separately.
// Writes <out>.json and a markdown summary next to it (<out>.md).
//
// Exit codes: 0 every request succeeded; 1 some failed; 2 usage; 3 the router is not usable (the
// first health check failed); 4 the output would have contained the password, nothing written;
// 5 unexpected error.
import { Buffer } from 'node:buffer';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { SMOKE_PROMPT } from '../cli/lib/commands.js';
import { normalizeUrl } from '../cli/lib/http.js';
import { readSecret } from '../cli/lib/prompt.js';
import { containsPassword } from '../scripts/live-smoke.mjs';
import { PROVIDER_IDS } from '../src/config.js';
import { SMOKE_MODELS } from '../src/pricing.js';
import { VERSION } from '../src/version.js';
import { ROOT, describe, parseServerTiming, r3, table } from './lib.mjs';

export const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2, UNUSABLE: 3, LEAK: 4, ERROR: 5 });
export const MAX_PER_PROVIDER = 30;
const MAX_HEALTH = 60;
const MIN_GAP_MS = 2000;
const MAX_TOKENS = 16;
const TIMEOUT_MS = 120_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

class UsageError extends Error {}

const USAGE =
  'usage: node bench/live.mjs --url https://<host> [--n 10] [--health-n 20] [--gap-ms 2000] [--providers claude,gemini,openrouter] [--out FILE.json]\n' +
  `The password is read from MROUTER_PASSWORD, else from stdin or a hidden prompt. --n is at most ${MAX_PER_PROVIDER} per provider;\n` +
  `--gap-ms is at least ${MIN_GAP_MS} unless the URL is loopback.`;

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{url?: string, out?: string, providers?: string[], n: number, healthN: number, gapMs: number, help: boolean}} */
  const o = { n: 10, healthN: 20, gapMs: MIN_GAP_MS, help: false };
  /** @param {string} flag @param {string} v @param {number} min @param {number} max */
  const int = (flag, v, min, max) => {
    const n = /^\d{1,7}$/.test(v) ? Number(v) : NaN;
    if (!(n >= min)) throw new UsageError(`${flag} must be an integer of at least ${min}`);
    if (n > max) {
      throw new UsageError(
        flag === '--n'
          ? `refusing --n ${n}: at most ${MAX_PER_PROVIDER} requests per provider (this samples latency; it is not a load test of real accounts)`
          : `${flag} must be at most ${max}`,
      );
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const [flag, inline] = a.startsWith('--') && eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, undefined];
    if (['--url', '--out', '--providers', '--n', '--health-n', '--gap-ms'].includes(flag)) {
      const v = inline ?? argv[++i];
      if (!v) throw new UsageError(`${flag} needs a value`);
      if (flag === '--url') o.url = v;
      else if (flag === '--out') o.out = v;
      else if (flag === '--n') o.n = int(flag, v, 1, MAX_PER_PROVIDER);
      else if (flag === '--health-n') o.healthN = int(flag, v, 1, MAX_HEALTH);
      else if (flag === '--gap-ms') o.gapMs = int(flag, v, 0, 600_000);
      else {
        const list = v.split(',').map((p) => p.trim());
        if (!list.every((p) => /** @type {readonly string[]} */ (PROVIDER_IDS).includes(p))) throw new UsageError(`--providers takes a comma-separated subset of ${PROVIDER_IDS.join(', ')}`);
        o.providers = [...new Set(list)];
      }
    } else if (a === '-h' || a === '--help') o.help = true;
    else throw new UsageError(/^--?[a-z-]{1,24}$/.test(flag) ? `unknown option ${flag}` : 'unexpected argument (the password is never accepted as an argument)');
  }
  if (!o.help && !o.url) throw new UsageError('--url is required');
  return o;
}

/** @param {unknown} err */
function networkResult(err) {
  const e = /** @type {any} */ (err);
  if (e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError') return 'timeout';
  if (/redirect/i.test(String(e?.cause?.message ?? ''))) return 'redirect_refused';
  return 'unreachable';
}

/** @param {any} json */
function errorCode(json) {
  const code = json?.error?.code;
  if (typeof code !== 'string') return null;
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(code) ? code : 'unrecognized_error_code';
}

/** @param {string} text */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * One request; never throws.
 * @param {string} origin @param {string} password
 * @param {{kind: 'health'} | {kind: 'chat', provider: string, model: string}} what
 */
async function measure(origin, password, what) {
  /** @type {Record<string, any>} */
  const rec = { ...what, http_status: null, result: 'error', ttfb_ms: null, total_ms: null, server_timing: {}, cold: false };
  const chat = what.kind === 'chat';
  const t0 = performance.now();
  try {
    const res = await fetch(origin + (chat ? '/v1/chat/completions' : '/control/health'), {
      method: chat ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${password}`,
        accept: 'application/json',
        'user-agent': `michael-router-live-bench/${VERSION}`,
        ...(chat ? { 'content-type': 'application/json' } : {}),
      },
      body: chat ? JSON.stringify({ model: what.model, messages: [{ role: 'user', content: SMOKE_PROMPT }], max_tokens: MAX_TOKENS }) : undefined,
      redirect: 'error', // the password never follows a redirect
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    /** @type {Buffer[]} */
    const chunks = [];
    for await (const c of /** @type {any} */ (res.body ?? [])) {
      rec.ttfb_ms ??= r3(performance.now() - t0);
      chunks.push(c);
    }
    rec.total_ms = r3(performance.now() - t0);
    rec.ttfb_ms ??= rec.total_ms;
    rec.http_status = res.status;
    rec.server_timing = parseServerTiming(res.headers.get('server-timing') ?? '');
    rec.cold = res.headers.get('x-router-cold') === '1';
    const json = parseJson(Buffer.concat(chunks).toString('utf8'));
    const ok = res.status === 200 && (chat ? Array.isArray(json?.choices) : json?.status === 'ok');
    rec.result = ok ? 'ok' : (errorCode(json) ?? `http_${res.status}`);
    if (!chat && ok) rec.health = { version: json.version, commit: json.commit ?? null, region: json.region ?? null, providers: json.providers };
    const { upstream, gw } = rec.server_timing;
    if (chat && typeof upstream === 'number') {
      rec.overhead_ms = r3(rec.total_ms - upstream);
      if (typeof gw === 'number') rec.in_router_ms = r3(gw - upstream);
    }
  } catch (err) {
    rec.result = networkResult(err);
  }
  return rec;
}

/** @param {Record<string, any>[]} recs */
function summarize(recs) {
  const ok = recs.filter((r) => r.result === 'ok');
  /** @param {(r: any) => unknown} f */
  const d = (f) => {
    const values = ok.map(f).filter((v) => typeof v === 'number');
    return values.length ? describe(values) : null;
  };
  return {
    n: recs.length,
    ok: ok.length,
    cold: recs.filter((r) => r.cold).length,
    total_ms: d((r) => r.total_ms),
    ttfb_ms: d((r) => r.ttfb_ms),
    upstream_ms: d((r) => r.server_timing.upstream),
    overhead_ms: d((r) => r.overhead_ms),
    in_router_ms: d((r) => r.in_router_ms),
    gw_ms: d((r) => r.server_timing.gw),
    store_ms: d((r) => r.server_timing.store),
    auth_ms: d((r) => r.server_timing.auth),
  };
}

/** @param {Record<string, any>} ev */
function markdown(ev) {
  /** @param {any} s @param {string} k */
  const cell = (s, k) => (s[k] ? `${s[k].p50} / ${s[k].p90} / ${s[k].max}` : '-');
  const lines = [
    `# Michael Router live latency, ${ev.started_at}`,
    '',
    `- Target: ${ev.target.origin} (${ev.target.live ? 'live deployment' : 'local target: mocked evidence, not a live deployment'})`,
    ev.router ? `- Router: version ${ev.router.version}, commit ${ev.router.commit ?? '-'}, region ${ev.router.region ?? '-'}` : '- Router: not reachable',
    `- Requests ${ev.config.gap_ms} ms apart; chat: ${ev.config.n} per provider, non-streaming, max_tokens ${MAX_TOKENS}; health: ${ev.config.health_n}`,
    `- Result: ${ev.result}`,
    '',
    'Milliseconds, p50 / p90 / max over successful requests. overhead = client total − upstream (router + network);',
    'in-router = gw − upstream (server-timing); upstream = provider time to response headers.',
    '',
  ];
  const rows = Object.entries(ev.summary).map(([group, s]) => [group, `${s.ok}/${s.n}`, s.cold, cell(s, 'total_ms'), cell(s, 'upstream_ms'), cell(s, 'overhead_ms'), cell(s, 'in_router_ms'), cell(s, 'gw_ms'), cell(s, 'store_ms')]);
  lines.push(table(['group', 'ok', 'cold', 'client total', 'upstream', 'overhead', 'in-router', 'gw', 'store'], rows), '');
  return `${lines.join('\n')}\n`;
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {string[]} argv */
export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.OK;
  }
  let origin;
  try {
    origin = new URL(normalizeUrl(/** @type {string} */ (opts.url))).origin;
  } catch (err) {
    throw new UsageError(/** @type {Error} */ (err).message);
  }
  const live = !LOOPBACK.has(new URL(origin).hostname);
  if (live && opts.gapMs < MIN_GAP_MS) throw new UsageError(`--gap-ms must be at least ${MIN_GAP_MS} for a deployed router`);
  let password = process.env.MROUTER_PASSWORD;
  if (!password) {
    try {
      password = await readSecret({ label: 'Router password: ', what: 'password', stdin: process.stdin, stderr: process.stderr });
    } catch (err) {
      throw new UsageError(/** @type {Error} */ (err).message);
    }
  }
  if (!/^[\x20-\x7e]+$/.test(password) || password !== password.trim()) throw new UsageError('the password must be printable ASCII without leading or trailing spaces');
  const secret = password;
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const outJson = path.resolve(opts.out ?? path.join(ROOT, 'evidence', 'speed', 'live', `${stamp}.json`));
  const outMd = outJson.endsWith('.json') ? `${outJson.slice(0, -5)}.md` : `${outJson}.md`;
  /** Progress on stderr, withheld if it would show the password. @param {string} line */
  const progress = (line) => process.stderr.write(`${containsPassword(secret, null, line) ? '(progress line withheld: it contains the router password)' : line}\n`);
  /** @param {Record<string, any>} r */
  const report = (r) =>
    progress(`${r.kind === 'chat' ? `${r.provider} chat` : 'health'}: ${r.result}${r.http_status ? ` (HTTP ${r.http_status})` : ''}, total ${r.total_ms ?? '-'} ms${r.server_timing.upstream === undefined ? '' : `, upstream ${r.server_timing.upstream} ms`}${r.cold ? ', cold' : ''}`);

  /** @type {Record<string, any>[]} */
  const records = [];
  const first = await measure(origin, secret, { kind: 'health' });
  records.push(first);
  report(first);
  const usable = first.result === 'ok';
  const configured = usable ? PROVIDER_IDS.filter((p) => first.health?.providers?.[p]?.configured) : [];
  const providers = (opts.providers ?? PROVIDER_IDS).filter((p) => configured.includes(p));
  if (usable) {
    // Round r: one health request (while any are left) and one chat request per provider.
    for (let round = 0; round < Math.max(opts.n, opts.healthN - 1); round++) {
      /** @type {Parameters<typeof measure>[2][]} */
      const batch = [];
      if (round < opts.healthN - 1) batch.push({ kind: 'health' });
      if (round < opts.n) for (const p of providers) batch.push({ kind: 'chat', provider: p, model: SMOKE_MODELS[/** @type {keyof typeof SMOKE_MODELS} */ (p)] });
      for (const what of batch) {
        await sleep(opts.gapMs);
        const r = await measure(origin, secret, what);
        records.push(r);
        report(r);
      }
    }
  }
  /** @type {Record<string, any>} */
  const summary = { health: summarize(records.filter((r) => r.kind === 'health')) };
  for (const p of providers) summary[p] = summarize(records.filter((r) => r.provider === p));
  const failed = records.filter((r) => r.result !== 'ok').length;
  const ev = {
    tool: 'bench/live.mjs',
    router_cli_version: VERSION,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    target: { origin, live },
    config: { n: opts.n, health_n: opts.healthN, gap_ms: opts.gapMs, max_tokens: MAX_TOKENS, providers_requested: opts.providers ?? PROVIDER_IDS, providers_measured: providers },
    router: first.health ? { version: first.health.version, commit: first.health.commit, region: first.health.region } : null,
    result: !usable ? `NOT USABLE: ${first.result}` : failed ? `FAIL (${failed} of ${records.length} requests failed)` : `PASS (${records.length} requests)`,
    summary,
    requests: records.map(({ health: _health, ...r }) => r),
  };
  const json = `${JSON.stringify(ev, null, 2)}\n`;
  const md = markdown(ev);
  if (containsPassword(secret, ev, json, md)) {
    process.stderr.write('live: aborted: the output contains the router password; nothing was written\n');
    return EXIT.LEAK;
  }
  await mkdir(path.dirname(outJson), { recursive: true });
  await writeFile(outJson, json);
  await writeFile(outMd, md);
  process.stdout.write(`${md}\nEvidence: ${outJson}\nSummary: ${outMd}\n`);
  if (!usable) return EXIT.UNUSABLE;
  return failed ? EXIT.FAILED : EXIT.OK;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      if (err instanceof UsageError) {
        process.stderr.write(`live: ${err.message}\n${USAGE}\n`);
        process.exitCode = EXIT.USAGE;
        return;
      }
      const why = typeof err?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(err.code) ? err.code : (err?.name ?? 'error');
      process.stderr.write(`live: unexpected error (${why}); the evidence and summary may be missing or incomplete\n`);
      process.exitCode = EXIT.ERROR;
    },
  );
}
