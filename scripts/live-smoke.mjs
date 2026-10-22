#!/usr/bin/env node
// Smoke run against a deployed Michael Router, after deployment (docs/DEPLOY.md step 6).
//
//   node scripts/live-smoke.mjs --url https://<host> [--out evidence/live/<stamp>.json] [--providers claude,gemini,openrouter]
//                               [--probe-wrong-password]
//
// The router password comes from MROUTER_PASSWORD, else from stdin (piped) or a hidden prompt.
// It is sent only to the --url origin, and no request follows a redirect.
//
// Checks, in order: /control/health (a missing or unreachable store, a misconfiguration, a
// refused password or a blocked source stop the run here), /control/keys, then per provider a
// non-streaming and a streaming chat completion with a tiny prompt on its smoke model
// (src/pricing.json `smoke_models`), plus one tool-call request for claude (a single `get_time`
// function), then /control/usage?days=1, /control/errors?limit=5 and one request without
// credentials (expect 401). Only with --probe-wrong-password, last, one wrong password (expect
// 401): it counts a failed attempt for this host's source, and failures add up within the
// limiter window. Keys are only read, never set.
//
// Per call it records only: provider, model, mode, HTTP status, x-router-* headers,
// server-timing, TTFB and total ms, token usage, cost and cost status, finish_reason, the first
// 60 characters of the reply (dropped if it shares 8 or more characters with the password), and
// the result. The JSON evidence and a markdown summary (same name, .md) are written only after
// every string in them was checked not to contain the password; progress lines are checked too.
// A run against a loopback URL is labelled as local, mocked evidence.
//
// Exit codes: 0 every check passed; 1 a check failed; 2 usage; 3 the deployment is not usable
// (unreachable, misconfigured, store missing or unavailable, password refused, source blocked);
// 4 the evidence contained the password, so nothing was written; 5 unexpected error (the
// evidence and summary may be missing or incomplete).
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { consumeStream, requestCost } from '../cli/lib/chat.js';
import { SMOKE_PROMPT } from '../cli/lib/commands.js';
import { normalizeUrl } from '../cli/lib/http.js';
import { readSecret } from '../cli/lib/prompt.js';
import { PROVIDER_IDS } from '../src/config.js';
import { SMOKE_MODELS } from '../src/pricing.js';
import { VERSION } from '../src/version.js';

export const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2, UNUSABLE: 3, LEAK: 4, ERROR: 5 });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTROL_TIMEOUT_MS = 30_000;
const CHAT_TIMEOUT_MS = 300_000;
const MAX_TOKENS = 256;
const REPLY_CHARS = 60;
const OVERLAP_CHARS = 8;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const TOOL_PROMPT = 'What time is it in UTC right now? Use the get_time tool.';
const GET_TIME = {
  type: 'function',
  function: {
    name: 'get_time',
    description: 'Returns the current time in a time zone.',
    parameters: { type: 'object', properties: { timezone: { type: 'string', description: 'IANA time zone, e.g. UTC' } }, required: ['timezone'] },
  },
};
const STORE_VARS = /^(?:DATABASE_URL|ROUTER_STORE)/;

class UsageError extends Error {}

/** @param {unknown} s */
const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
/** @param {number | null | undefined} ms */
const round = (ms) => (typeof ms === 'number' ? Math.round(ms * 10) / 10 : null);
/** @param {unknown} text */
const snippet = (text) => Array.from(clean(text)).slice(0, REPLY_CHARS).join('');

/** @param {string} text @returns {any} */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** @param {unknown} err */
function networkResult(err) {
  const e = /** @type {any} */ (err);
  if (e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError') return 'timeout';
  if (/redirect/i.test(String(e?.cause?.message ?? ''))) return 'redirect_refused';
  return 'unreachable';
}

/** @param {Headers} headers */
function routerHeaders(headers) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of headers) if (k.startsWith('x-router-')) out[k] = clean(v);
  return out;
}

/** The error code of a response body, only when it is code-shaped. @param {any} json */
function errorCode(json) {
  if (!json || typeof json.error?.code !== 'string') return null;
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(json.error.code) ? json.error.code : 'unrecognized_error_code';
}

/**
 * @param {string} origin
 * @param {{password?: string, timeoutMs?: number}} defaults
 */
function client(origin, defaults) {
  /**
   * @param {string} route @param {{method?: string, body?: unknown, password?: string | null, timeoutMs?: number}} [o]
   */
  async function open(route, o = {}) {
    /** @type {Record<string, string>} */
    const headers = { accept: 'application/json', 'user-agent': `michael-router-live-smoke/${VERSION}` };
    const password = o.password === null ? undefined : (o.password ?? defaults.password);
    if (password !== undefined) headers.authorization = `Bearer ${password}`;
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    const t0 = performance.now();
    const res = await fetch(origin + route, {
      method: o.method ?? 'GET',
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
      redirect: 'error', // the password never follows a redirect
      signal: AbortSignal.timeout(o.timeoutMs ?? defaults.timeoutMs ?? CONTROL_TIMEOUT_MS),
    });
    return { res, t0 };
  }
  /** A complete request: {status, headers, json, ttfbMs, totalMs} or {network}. @param {string} route @param {Parameters<typeof open>[1]} [o] */
  async function request(route, o) {
    try {
      const { res, t0 } = await open(route, o);
      /** @type {Buffer[]} */
      const chunks = [];
      let ttfb;
      for await (const c of /** @type {any} */ (res.body ?? [])) {
        ttfb ??= performance.now() - t0;
        chunks.push(c);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      return { status: res.status, headers: res.headers, json: parseJson(text), ttfbMs: ttfb ?? performance.now() - t0, totalMs: performance.now() - t0 };
    } catch (err) {
      return { network: networkResult(err) };
    }
  }
  return { open, request };
}

/** Whether `text` shares a run of OVERLAP_CHARS or more characters with the password. @param {string} text @param {string} password */
function overlaps(text, password) {
  const n = Math.min(OVERLAP_CHARS, password.length);
  for (let i = 0; i + n <= password.length; i++) if (text.includes(password.slice(i, i + n))) return true;
  return false;
}

/**
 * One chat completion. Never throws.
 * @param {ReturnType<typeof client>} c @param {string} provider @param {string} model @param {'non-stream' | 'stream' | 'tool-call'} mode
 * @param {string} password
 */
async function chat(c, provider, model, mode, password) {
  const stream = mode === 'stream';
  const body = {
    model,
    messages: [{ role: 'user', content: mode === 'tool-call' ? TOOL_PROMPT : SMOKE_PROMPT }],
    max_tokens: MAX_TOKENS,
    ...(mode === 'tool-call' ? { tools: [GET_TIME] } : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
  /** @type {Record<string, any>} */
  const call = {
    provider,
    model,
    mode,
    ok: false,
    result: 'error',
    http_status: null,
    router_headers: {},
    server_timing: null,
    ttfb_ms: null,
    total_ms: null,
    usage: null,
    cost: null,
    finish_reason: null,
    reply: null,
  };
  /** @type {any} */
  let response;
  try {
    const { res, t0 } = await c.open('/v1/chat/completions', { method: 'POST', body, timeoutMs: CHAT_TIMEOUT_MS });
    Object.assign(call, { http_status: res.status, router_headers: routerHeaders(res.headers), server_timing: res.headers.get('server-timing') });
    const streamed = stream && res.ok && /text\/event-stream/.test(res.headers.get('content-type') ?? '');
    if (streamed) {
      const r = await consumeStream(res, t0, {}, (err) => /** @type {Error} */ (err));
      Object.assign(call, { ttfb_ms: round(r.ttfbMs), total_ms: round(r.totalMs) });
      response = r.response;
      call.result = r.error ? `stream_error:${errorCode({ error: r.error }) ?? 'unknown'}` : r.done ? 'ok' : 'stream_incomplete';
    } else {
      /** @type {Buffer[]} */
      const chunks = [];
      let ttfb;
      for await (const chunk of /** @type {any} */ (res.body ?? [])) {
        ttfb ??= performance.now() - t0;
        chunks.push(chunk);
      }
      Object.assign(call, { ttfb_ms: round(ttfb ?? performance.now() - t0), total_ms: round(performance.now() - t0) });
      const json = parseJson(Buffer.concat(chunks).toString('utf8'));
      if (res.ok && Array.isArray(json?.choices)) {
        response = json;
        call.result = stream ? 'not_a_stream' : 'ok';
      } else call.result = errorCode(json) ?? (res.ok ? 'unexpected_body' : `http_${res.status}`);
    }
  } catch (err) {
    call.result = call.http_status === null ? networkResult(err) : 'stream_broken';
  }
  if (response) {
    const choice = response.choices?.[0] ?? {};
    const { usage, cost } = requestCost(provider, model, response.usage);
    call.usage = usage;
    call.cost = { usd: cost.status === 'unknown' ? null : cost.usd, status: cost.status };
    call.finish_reason = typeof choice.finish_reason === 'string' ? clean(choice.finish_reason) : null;
    const tools = Array.isArray(choice.message?.tool_calls) ? choice.message.tool_calls.map((/** @type {any} */ t) => clean(t?.function?.name)) : [];
    const reply = snippet(tools.length ? `tool_calls: ${tools.join(', ')}` : choice.message?.content);
    call.reply = overlaps(reply, password) ? null : reply;
    if (mode === 'tool-call' && call.result === 'ok' && !tools.includes('get_time')) call.result = 'no_tool_call';
  }
  call.ok = call.result === 'ok';
  return call;
}

/**
 * Why the deployment cannot be smoke-tested, from the health response, or null.
 * @param {Awaited<ReturnType<ReturnType<typeof client>['request']>>} h @param {string} origin
 */
function diagnose(h, origin) {
  if ('network' in h) return { code: h.network, message: `cannot reach ${origin} (${h.network})` };
  const code = errorCode(h.json);
  if (h.status === 200 && h.json?.status === 'ok') return null;
  if (h.status === 503 && code === 'store_unavailable') {
    return {
      code,
      message:
        'store unavailable (503 store_unavailable): the router has a database URL but the store failed or answered too slowly. ' +
        'Check that the Postgres database is reachable, that its URL and password are current, and that the migrations have run.',
    };
  }
  if (h.status === 503 && code === 'server_misconfigured') {
    const names = [...new Set(String(h.json?.error?.message ?? '').match(/[A-Z][A-Z0-9_]+(?:\/[A-Z][A-Z0-9_]+)*/g) ?? [])];
    const store = names.filter((n) => STORE_VARS.test(n));
    const other = names.filter((n) => !STORE_VARS.test(n));
    if (store.length) {
      return {
        code: 'store_missing',
        message:
          `store missing or invalid (503 server_misconfigured: ${store.join(', ')}). Set DATABASE_URL_POOLED (preferred) or ` +
          'DATABASE_URL to a Postgres URL with sslmode=require, run the migrations, then redeploy' +
          (other.length ? `; also missing or invalid: ${other.join(', ')}` : ''),
      };
    }
    return { code, message: `server misconfigured (503): ${other.join(', ') || 'see the deployment environment'} missing or invalid` };
  }
  if (h.status === 401) return { code: code ?? 'unauthorized', message: `the router refused the password (401 ${code}); stopped so no further failures are counted` };
  if (h.status === 429) {
    const retry = h.headers.get('retry-after');
    return { code: code ?? 'rate_limited', message: `this source is slowed down or blocked (429 ${code}${retry ? `, Retry-After ${clean(retry)} s` : ''})` };
  }
  return { code: code ?? `http_${h.status}`, message: `unexpected HTTP ${h.status} from /control/health` };
}

/** Control check record. @param {Awaited<ReturnType<ReturnType<typeof client>['request']>>} r @param {(r: any) => boolean} pass */
function control(r, pass) {
  if ('network' in r) return { ok: false, http_status: null, result: r.network };
  const ok = pass(r);
  return { ok, http_status: r.status, result: ok ? 'ok' : (errorCode(r.json) ?? `http_${r.status}`), ttfb_ms: round(r.ttfbMs), total_ms: round(r.totalMs) };
}

/** @param {Record<string, any>} ev */
function markdown(ev) {
  const lines = [`# Michael Router live smoke, ${ev.started_at}`, ''];
  lines.push(`- Target: ${ev.target.origin} (${ev.target.live ? 'live deployment' : 'local target: mocked evidence, not a live deployment'})`);
  const h = ev.control.health?.body;
  if (h) lines.push(`- Router: version ${clean(h.version)}, commit ${clean(h.commit ?? '-')}, region ${clean(h.region ?? '-')}, store ${clean(h.store?.kind)} ${clean(h.store?.latency_ms)} ms`);
  lines.push(`- Result: ${ev.result}${ev.diagnosis ? ` (${ev.diagnosis.message})` : ''}`, '');
  if (ev.calls.length) {
    lines.push('| provider | model | mode | HTTP | result | TTFB ms | total ms | tokens p/c/cached | cost | finish | reply |', '|---|---|---|---|---|---|---|---|---|---|---|');
    for (const c of ev.calls) {
      const tokens = c.usage ? `${c.usage.prompt_tokens}/${c.usage.completion_tokens}/${c.usage.cached_tokens}` : '-';
      const cost = c.cost ? (c.cost.usd === null ? c.cost.status : `$${c.cost.usd.toFixed(6)} ${c.cost.status}`) : '-';
      const cells = [c.provider, c.model, c.mode, c.http_status ?? '-', c.result, c.ttfb_ms ?? '-', c.total_ms ?? '-', tokens, cost, c.finish_reason ?? '-', c.reply ?? ''];
      lines.push(`| ${cells.map((x) => String(x).replace(/\|/g, '\\|')).join(' | ')} |`);
    }
    lines.push('');
  }
  lines.push('| check | HTTP | result |', '|---|---|---|');
  for (const [name, r] of Object.entries(ev.control)) lines.push(`| ${name} | ${r.http_status ?? '-'} | ${r.result} |`);
  lines.push('');
  if (ev.control.wrong_password) lines.push('The wrong-password probe counted one failed attempt for this host\'s source.', '');
  return lines.join('\n');
}

/** Every form of the password that must never appear in evidence: raw, base64, base64url,
 * URL-, JSON- and markdown-escaped. @param {string} password */
function passwordForms(password) {
  const b = Buffer.from(password, 'utf8');
  const url = encodeURIComponent(password);
  const json = JSON.stringify(password).slice(1, -1);
  return [...new Set([password, b.toString('base64'), b.toString('base64url'), url, url.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()), json, json.replaceAll('/', '\\/'), password.replace(/\|/g, '\\|')])];
}

/**
 * Whether the password, in any of its forms, occurs in any string inside `value` (before any
 * serialization could escape it) or in one of the serialized `texts`.
 * @param {string} password @param {unknown} value @param {...string} texts
 */
export function containsPassword(password, value, ...texts) {
  const forms = passwordForms(password);
  /** @type {string[]} */
  const strings = [...texts];
  (function walk(/** @type {unknown} */ v) {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        strings.push(k);
        walk(x);
      }
    }
  })(value);
  return strings.some((t) => forms.some((f) => t.includes(f)));
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{url?: string, out?: string, providers?: string[], probeWrongPassword: boolean, help: boolean}} */
  const o = { probeWrongPassword: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const [flag, inline] = a.startsWith('--') && eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, undefined];
    if (flag === '--url' || flag === '--out' || flag === '--providers') {
      const v = inline ?? argv[++i];
      if (!v) throw new UsageError(`${flag} needs a value`);
      if (flag === '--providers') {
        const list = v.split(',').map((p) => p.trim());
        if (!list.every((p) => /** @type {readonly string[]} */ (PROVIDER_IDS).includes(p))) throw new UsageError(`--providers takes a comma-separated subset of ${PROVIDER_IDS.join(', ')}`);
        o.providers = [...new Set(list)];
      } else o[flag === '--url' ? 'url' : 'out'] = v;
    } else if (a === '--probe-wrong-password') o.probeWrongPassword = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new UsageError(/^--?[a-z-]{1,24}$/.test(flag) ? `unknown option ${flag}` : 'unexpected argument (the password is never accepted as an argument)');
  }
  if (!o.help && !o.url) throw new UsageError('--url is required');
  return o;
}

const USAGE =
  'usage: node scripts/live-smoke.mjs --url https://<host> [--out evidence/live/<stamp>.json] [--providers claude,gemini,openrouter] [--probe-wrong-password]\n' +
  'The password is read from MROUTER_PASSWORD, else from stdin or a hidden prompt. --probe-wrong-password also sends one wrong\n' +
  'password (expects 401); it counts a failed attempt for this source.';

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
  let password = process.env.MROUTER_PASSWORD;
  if (!password) {
    try {
      password = await readSecret({ label: 'Router password: ', what: 'password', stdin: process.stdin, stderr: process.stderr });
    } catch (err) {
      throw new UsageError(/** @type {Error} */ (err).message);
    }
  }
  if (!/^[\x20-\x7e]+$/.test(password) || password !== password.trim()) throw new UsageError('the password must be printable ASCII without leading or trailing spaces');
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const outJson = path.resolve(opts.out ?? path.join(ROOT, 'evidence', 'live', `${stamp}.json`));
  const outMd = outJson.endsWith('.json') ? `${outJson.slice(0, -5)}.md` : `${outJson}.md`;
  const live = !LOOPBACK.has(new URL(origin).hostname);
  const c = client(origin, { password });
  /** Progress on stderr, withheld if it would show the password. @param {string} line */
  const progress = (line) => process.stderr.write(`${containsPassword(password, null, line) ? '(progress line withheld: it contains the router password)' : line}\n`);

  /** @type {Record<string, any>} */
  const ev = { tool: 'scripts/live-smoke.mjs', router_cli_version: VERSION, started_at: startedAt.toISOString(), target: { origin, live }, result: null, diagnosis: null, calls: [], control: {} };
  const health = await c.request('/control/health');
  ev.control.health = { ...control(health, (r) => r.status === 200 && r.json?.status === 'ok'), ...(!('network' in health) && health.status === 200 ? { body: health.json } : {}) };
  ev.diagnosis = diagnose(health, origin);
  progress(`health: ${ev.control.health.result}`);

  if (!ev.diagnosis) {
    const keys = await c.request('/control/keys');
    ev.control.keys = { ...control(keys, (r) => r.status === 200 && Array.isArray(r.json)), keys: !('network' in keys) && Array.isArray(keys.json) ? keys.json : null };
    const configured = new Set((ev.control.keys.keys ?? []).filter((/** @type {any} */ k) => k?.configured).map((/** @type {any} */ k) => k.provider));
    for (const provider of opts.providers ?? PROVIDER_IDS) {
      const model = SMOKE_MODELS[/** @type {keyof typeof SMOKE_MODELS} */ (provider)];
      const modes = /** @type {const} */ (provider === 'claude' ? ['non-stream', 'stream', 'tool-call'] : ['non-stream', 'stream']);
      for (const mode of modes) {
        const call = configured.has(provider) ? await chat(c, provider, model, mode, password) : { provider, model, mode, ok: false, result: 'provider_not_configured', http_status: null };
        ev.calls.push(call);
        progress(`${provider} ${mode}: ${call.result}${call.http_status ? ` (HTTP ${call.http_status})` : ''}`);
      }
    }
    const usage = await c.request('/control/usage?days=1');
    ev.control.usage = { ...control(usage, (r) => r.status === 200 && r.json?.totals !== undefined), ...(!('network' in usage) && usage.status === 200 ? { body: usage.json } : {}) };
    const errors = await c.request('/control/errors?limit=5');
    const events = !('network' in errors) && Array.isArray(errors.json) ? errors.json : null;
    ev.control.errors = {
      ...control(errors, (r) => r.status === 200 && Array.isArray(r.json)),
      // without the failed-login source address
      events: events?.map((/** @type {any} */ e) => ({ ts: e.ts, kind: e.kind, code: e.code, status: e.status, provider: e.provider, model: e.model, request_id: e.request_id })) ?? null,
    };
    const anonymous = await c.request('/control/health', { password: null });
    ev.control.unauthenticated = control(anonymous, (r) => r.status === 401 && errorCode(r.json) === 'missing_credentials');
    if (opts.probeWrongPassword) {
      let wrong = `smoke-wrong-${randomBytes(12).toString('hex')}`;
      if (wrong === password) wrong += 'x';
      const rejected = await c.request('/control/health', { password: wrong });
      ev.control.wrong_password = { ...control(rejected, (r) => r.status === 401 && errorCode(r.json) === 'invalid_credentials'), note: 'counts one failed attempt for this source' };
    }
    for (const name of ['usage', 'errors', 'unauthenticated', 'wrong_password']) if (ev.control[name]) progress(`${name.replace('_', ' ')}: ${ev.control[name].result}`);
  }
  const checks = [...ev.calls, ...Object.values(ev.control)];
  const failed = checks.filter((x) => !x.ok).length;
  ev.result = ev.diagnosis ? `NOT USABLE: ${ev.diagnosis.code}` : failed ? `FAIL (${failed} of ${checks.length} checks failed)` : `PASS (${checks.length} checks)`;
  ev.finished_at = new Date().toISOString();

  const json = `${JSON.stringify(ev, null, 2)}\n`;
  const md = markdown(ev);
  if (containsPassword(password, ev, json, md)) {
    process.stderr.write('live-smoke: aborted: the evidence contains the router password; nothing was written\n');
    return EXIT.LEAK;
  }
  await mkdir(path.dirname(outJson), { recursive: true });
  await writeFile(outJson, json);
  await writeFile(outMd, md);
  process.stdout.write(`${md}\nEvidence: ${outJson}\nSummary: ${outMd}\n`);
  if (ev.diagnosis) {
    process.stderr.write(`live-smoke: ${ev.diagnosis.message}\n`);
    return EXIT.UNUSABLE;
  }
  return failed ? EXIT.FAILED : EXIT.OK;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      if (err instanceof UsageError) {
        process.stderr.write(`live-smoke: ${err.message}\n${USAGE}\n`);
        process.exitCode = EXIT.USAGE;
        return;
      }
      const why = typeof err?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(err.code) ? err.code : (err?.name ?? 'error');
      process.stderr.write(`live-smoke: unexpected error (${why}); the evidence and summary may be missing or incomplete\n`);
      process.exitCode = EXIT.ERROR;
    },
  );
}
