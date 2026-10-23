// Every mrouter command (DESIGN §9). Each `run(ctx)` prints its result (a table, or the JSON with
// --json) and throws a CliError for a nonzero exit, after printing whatever result it has.
import { hashPassword } from '../../src/auth.js';
import { MIN_PASSWORD_LENGTH, PROVIDER_IDS, providerKeyProblem } from '../../src/config.js';
import { EVENT_KINDS } from '../../src/events.js';
import { SMOKE_MODELS } from '../../src/pricing.js';
import { GatewayError } from '../../src/http.js';
import { routeModel } from '../../src/routing.js';
import { usageDays } from '../../src/usage.js';
import { intFlag } from './args.js';
import { consumeStream, requestCost, streamFailure } from './chat.js';
import { deleteCredentials, fileMode, passwordShapeOk, writeConfig, writeCredentials } from './config.js';
import { CliError, EXIT, usageError } from './errors.js';
import { clean, createClient } from './http.js';
import { readStdinText } from './prompt.js';
import { costMarker, costWords, fmtInt, fmtMs, fmtTime, renderPairs, renderTable, terminalSafe } from './output.js';

/** @typedef {import('./main.js').Context} Context */

export const KEY_ARGUMENT_REFUSAL = 'provider keys are never accepted as arguments; pipe them on stdin or use the prompt';
export const PASSWORD_ARGUMENT_REFUSAL = 'passwords are never accepted as arguments; pipe them on stdin or use the prompt';
export const DEFAULT_ASK_MODEL = SMOKE_MODELS.gemini;
export const SMOKE_PROMPT = 'Reply with the single word: pong';
const SMOKE_MAX_TOKENS = 256;
const CONTROL_TIMEOUT_S = 30;
const CHAT_TIMEOUT_S = 300;
const SAFE_WORD = /^[a-z][a-z0-9-]{0,23}$/;

/** @param {unknown} v */
const yesNo = (v) => (v ? 'yes' : 'no');
/** @param {unknown} v */
const shown = (v) => (v === null || v === undefined || v === '' ? '-' : clean(v));

/** @param {string} password @param {string} where */
function checkPasswordShape(password, where) {
  if (!passwordShapeOk(password)) throw usageError(`${where} must be printable ASCII without leading or trailing spaces`);
}

/** The single provider argument of `keys set` / `keys unset`. @param {Context} ctx @param {boolean} secretContext */
function providerArg(ctx, secretContext) {
  const [provider, ...extra] = ctx.positionals;
  const verb = ctx.path.join(' ');
  if (provider === undefined) throw usageError(`${verb} needs a provider: ${PROVIDER_IDS.join(', ')}`);
  const known = /** @type {readonly string[]} */ (PROVIDER_IDS).includes(provider);
  if (secretContext && (extra.length || !(known || SAFE_WORD.test(provider)))) throw usageError(KEY_ARGUMENT_REFUSAL);
  if (!known) throw usageError(`unknown provider${SAFE_WORD.test(provider) ? ` "${provider}"` : ''}; use one of: ${PROVIDER_IDS.join(', ')}`);
  if (extra.length) throw usageError(`${verb} takes exactly one provider`);
  return /** @type {'claude' | 'gemini' | 'openrouter'} */ (provider);
}

/** @param {Context} ctx @param {string} message */
function noArguments(ctx, message = `${ctx.path.join(' ')} takes no arguments`) {
  if (ctx.positionals.length) throw usageError(message);
}

// ------------------------------------------------------------------ login / logout / status

/** @param {Context} ctx */
async function login(ctx) {
  noArguments(ctx, 'login takes no arguments; the password is read from the prompt or stdin, never from arguments');
  const { url } = await ctx.resolveUrl();
  const password = ctx.secret(await ctx.readSecret('Router password: ', 'password'));
  checkPasswordShape(password, 'the password');
  const client = createClient({ url, password, timeoutMs: ctx.timeoutMs(CONTROL_TIMEOUT_S) });
  let health;
  try {
    health = (await client.get('/control/health')).json;
  } catch (err) {
    if (err instanceof CliError) err.hint = 'nothing was saved';
    throw err;
  }
  if (!health || health.status !== 'ok') throw new CliError(`unexpected /control/health response from ${url}; nothing was saved`);
  // The old password goes first, so a failure part-way never leaves it paired with the new URL.
  await deleteCredentials(ctx.paths);
  await writeConfig(ctx.paths, { url });
  await writeCredentials(ctx.paths, password);
  if (ctx.json) return ctx.printJson({ url, config: ctx.paths.config, credentials: ctx.paths.credentials });
  ctx.print(`Logged in to ${url}.\nThe password is stored in ${ctx.paths.credentials} (mode 0600).\n`);
}

/** @param {Context} ctx */
async function logout(ctx) {
  noArguments(ctx);
  const removed = await deleteCredentials(ctx.paths);
  if (ctx.json) return ctx.printJson({ removed, credentials: ctx.paths.credentials });
  ctx.print(removed ? `Removed the stored password (${ctx.paths.credentials}).\n` : 'No stored password.\n');
  if (ctx.env.MROUTER_PASSWORD) ctx.warn('MROUTER_PASSWORD is still set in this environment');
}

/** @param {Context} ctx */
async function status(ctx) {
  noArguments(ctx);
  const { paths } = ctx;
  const config = await ctx.config();
  const target = await ctx.resolveUrl({ required: false });
  const [dirMode, configMode, credMode] = await Promise.all([fileMode(paths.dir), fileMode(paths.config), fileMode(paths.credentials)]);
  if (credMode !== null && credMode & 0o077) ctx.warn(`${paths.credentials} is accessible by other users (mode ${credMode.toString(8).padStart(4, '0')}); run: chmod 600 '${paths.credentials}'`);
  const stored = credMode !== null;
  const env = Boolean(ctx.env.MROUTER_PASSWORD);
  const storedFor = stored ? (config.url ?? null) : null;
  const usable = env || (stored && target !== null && storedFor === target.url);
  if (ctx.json) {
    return ctx.printJson({
      url: target?.url ?? null,
      url_source: target?.source ?? null,
      password: { stored, stored_for: storedFor, env, usable },
      paths: { dir: paths.dir, config: paths.config, credentials: paths.credentials },
    });
  }
  /** @param {number | null} mode */
  const mode = (mode) => (mode === null ? 'missing' : `mode ${mode.toString(8).padStart(4, '0')}`);
  let password = "not stored (run 'mrouter login')";
  if (env) password = 'from MROUTER_PASSWORD (overrides any stored password)';
  else if (stored && usable) password = 'stored';
  else if (stored) password = `stored for ${storedFor ?? 'an unknown URL'} only (not sent to other URLs)`;
  ctx.print(
    renderPairs(
      [
        ['URL', target ? `${target.url} (from ${target.source})` : "not set (use --url, MROUTER_URL or 'mrouter login --url URL')"],
        ['Password', password],
        ['Config dir', `${paths.dir} (${mode(dirMode)})`],
        ['config.json', `${paths.config} (${mode(configMode)})`],
        ['credentials', `${paths.credentials} (${mode(credMode)})`],
      ],
      ctx.c,
    ),
  );
}

// ------------------------------------------------------------------ control routes

/** @param {Context} ctx */
async function health(ctx) {
  noArguments(ctx);
  const client = await ctx.client(CONTROL_TIMEOUT_S);
  const { json: h, totalMs } = await client.get('/control/health');
  if (ctx.json) return ctx.printJson(h);
  const providers = Object.entries(h.providers ?? {})
    .map(([id, p]) => `${clean(id)} ${/** @type {any} */ (p)?.configured ? 'configured' : ctx.c.yellow('not configured')}`)
    .join(', ');
  ctx.print(
    renderPairs(
      [
        ['URL', ctx.url ?? '-'],
        ['Status', h.status === 'ok' ? ctx.c.green('ok') : shown(h.status)],
        ['Version', `${shown(h.version)}${h.commit ? ` (commit ${clean(h.commit)})` : ''}`],
        ['Region', shown(h.region)],
        ['Instance', `started ${fmtTime(h.instance?.started_at, ctx.now())}, ${h.instance?.cold ? 'cold start' : 'warm'}`],
        ['Store', `${shown(h.store?.kind)}, ${fmtMs(h.store?.latency_ms)}`],
        ['Providers', providers || '-'],
        ['Round trip', fmtMs(totalMs)],
      ],
      ctx.c,
    ),
  );
}

/** @param {Context} ctx */
async function keysList(ctx) {
  noArguments(ctx);
  const client = await ctx.client(CONTROL_TIMEOUT_S);
  const { json } = await client.get('/control/keys');
  if (ctx.json) return ctx.printJson(json);
  const rows = (Array.isArray(json) ? json : []).map((k) => [
    shown(k.provider),
    k.configured ? 'yes' : { text: 'no', style: ctx.c.yellow },
    shown(k.source),
    k.updated_at ? fmtTime(k.updated_at, ctx.now()) : '-',
  ]);
  ctx.print(renderTable([{ header: 'PROVIDER' }, { header: 'CONFIGURED' }, { header: 'SOURCE' }, { header: 'UPDATED' }], rows, ctx.c));
}

/** @param {Context} ctx */
async function keysSet(ctx) {
  const provider = providerArg(ctx, true);
  const verify = !ctx.flags['no-verify'];
  const client = await ctx.client(CONTROL_TIMEOUT_S);
  const key = ctx.secret(await ctx.readSecret(`${provider} API key: `, `${provider} key`));
  const problem = providerKeyProblem(key);
  if (problem) throw usageError(`invalid ${provider} key: ${problem}; nothing was sent`);
  let r;
  try {
    ({ json: r } = await client.request('PUT', `/control/keys/${provider}`, { key, verify }));
  } catch (err) {
    throw keyNotStored(err, provider);
  }
  if (ctx.json) return ctx.printJson(r);
  ctx.print(`Stored the ${provider} key on the router (updated ${fmtTime(r.updated_at, ctx.now())}).\n`);
  if (!verify) ctx.print('Not verified (--no-verify).\n');
  else ctx.print(`${ctx.c.green('Verified')}: ${provider} accepted the key (HTTP ${shown(r.upstream_status)}).\n`);
}

/**
 * The router verifies before storing: a rejected or unverifiable key is refused, never stored.
 * @param {unknown} err @param {string} provider
 */
function keyNotStored(err, provider) {
  if (!(err instanceof CliError)) return err;
  if (err.code === 'key_rejected') {
    return new CliError(`${provider} rejected the key (HTTP ${shown(err.upstreamStatus)}); it was not stored`, EXIT.UPSTREAM, {
      hint: `check the key and run 'mrouter keys set ${provider}' again`,
    });
  }
  if (err.code === 'key_verification_unavailable') {
    const why = err.upstreamStatus === undefined ? 'the provider could not be reached' : `the provider answered HTTP ${err.upstreamStatus}`;
    return new CliError(`could not verify the ${provider} key (${why}); it was not stored`, EXIT.UPSTREAM, {
      hint: `retry, or store it unverified with 'mrouter keys set ${provider} --no-verify'`,
    });
  }
  return err;
}

/** @param {Context} ctx */
async function keysUnset(ctx) {
  const provider = providerArg(ctx, false);
  const client = await ctx.client(CONTROL_TIMEOUT_S);
  const { json: r } = await client.request('DELETE', `/control/keys/${provider}`);
  if (ctx.json) return ctx.printJson(r);
  const now = r.source === 'env' ? 'the environment key' : ctx.c.yellow('no key (the provider is not configured)');
  ctx.print(`${r.removed ? `Removed the stored ${provider} key.` : `No stored ${provider} key.`} ${provider} now uses ${now}.\n`);
}

/** @param {Context} ctx */
async function models(ctx) {
  noArguments(ctx);
  const client = await ctx.client(CONTROL_TIMEOUT_S);
  const { json } = await client.get('/v1/models');
  if (ctx.json) return ctx.printJson(json);
  const data = Array.isArray(json?.data) ? json.data : [];
  if (!data.length) return ctx.print('No models: no provider is configured.\n');
  const rows = data.map((/** @type {any} */ m) => [shown(m.id), shown(m.owned_by), fmtInt(m.context_length), fmtInt(m.max_output_tokens)]);
  ctx.print(renderTable([{ header: 'MODEL' }, { header: 'PROVIDER' }, { header: 'CONTEXT', right: true }, { header: 'MAX OUTPUT', right: true }], rows, ctx.c));
}

/** @param {Context} ctx */
async function usage(ctx) {
  noArguments(ctx);
  const days = intFlag(ctx.flags.days, 'days', 1, 400);
  const since = ctx.flags.since;
  if (days !== undefined && since !== undefined) throw usageError('use either --days or --since, not both');
  if (since !== undefined) {
    // The router's own rule (a real UTC date, not in the future, at most 400 days ago).
    try {
      usageDays(new URLSearchParams({ since: String(since) }), ctx.now());
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
      throw usageError(`--${err.message.replace(/\.$/, '')}`);
    }
  }
  const client = await ctx.client(CONTROL_TIMEOUT_S);
  const query = since !== undefined ? `since=${since}` : `days=${days ?? 30}`;
  const { json: u } = await client.get(`/control/usage?${query}`);
  if (ctx.json) return ctx.printJson(u);
  ctx.print(`Usage ${shown(u.from)} to ${shown(u.to)} (${fmtInt(u.days)} UTC day${u.days === 1 ? '' : 's'})\n`);
  const rowsIn = Array.isArray(u.models) ? u.models : [];
  if (!rowsIn.length) return ctx.print('No usage recorded.\n');
  /** @param {any} r */
  const cost = (r) => {
    const text = costMarker(r.cost_usd, r.cost_status);
    return r.cost_status === 'unknown' || r.cost_status === 'partial' ? { text, style: ctx.c.yellow } : text;
  };
  /** @param {any} r @param {string} provider @param {string} model */
  const row = (r, provider, model) => [provider, model, fmtInt(r.requests), fmtInt(r.errors), fmtInt(r.prompt_tokens), fmtInt(r.completion_tokens), fmtInt(r.cached_tokens), cost(r)];
  const rows = rowsIn.map((/** @type {any} */ r) => row(r, shown(r.provider), shown(r.model)));
  rows.push(row(u.totals, 'total', ''));
  const columns = [
    { header: 'PROVIDER' },
    { header: 'MODEL' },
    { header: 'REQUESTS', right: true },
    { header: 'ERRORS', right: true },
    { header: 'PROMPT', right: true },
    { header: 'COMPLETION', right: true },
    { header: 'CACHED', right: true },
    { header: 'COST', right: true },
  ];
  ctx.print(renderTable(columns, rows, ctx.c, { totals: true }));
  const missing = u.totals?.usage_missing ?? 0;
  const notes = ['cost: exact = reported by the provider, est = from the price table, unknown = no price or no usage reported, ≥ partial = lower bound'];
  if (missing > 0) notes.push(`${fmtInt(missing)} request${missing === 1 ? '' : 's'} reported no usage`);
  ctx.print(ctx.c.dim(`${notes.join('; ')}.`) + '\n');
}

/** @param {Context} ctx */
async function errors(ctx) {
  noArguments(ctx);
  const limit = intFlag(ctx.flags.limit, 'limit', 1, 200);
  const kind = ctx.flags.kind;
  if (kind !== undefined && !(typeof kind === 'string' && EVENT_KINDS.includes(kind))) throw usageError(`--kind must be one of: ${EVENT_KINDS.join(', ')}`);
  const client = await ctx.client(CONTROL_TIMEOUT_S);
  const { json } = await client.get(`/control/errors?limit=${limit ?? 50}${kind ? `&kind=${kind}` : ''}`);
  if (ctx.json) return ctx.printJson(json);
  const events = Array.isArray(json) ? json : [];
  if (!events.length) return ctx.print('No recent events.\n');
  const rows = events.map((/** @type {any} */ e) => [
    fmtTime(e.ts, ctx.now()),
    shown(e.kind),
    { text: shown(e.code), style: ctx.c.red },
    shown(e.status),
    e.provider ? `${clean(e.provider)}${e.model ? `/${clean(e.model)}` : ''}` : shown(e.model),
    shown(e.source),
    shown(e.message),
  ]);
  const columns = [{ header: 'TIME' }, { header: 'KIND' }, { header: 'CODE' }, { header: 'STATUS', right: true }, { header: 'PROVIDER/MODEL' }, { header: 'SOURCE' }, { header: 'MESSAGE' }];
  ctx.print(renderTable(columns, rows, ctx.c));
}

// ------------------------------------------------------------------ chat: ask / test

/**
 * @param {Context} ctx @param {string} provider @param {string} model
 * @param {{usage: any, cost: any}} uc @param {{ttfbMs: number, totalMs: number, servedModel?: unknown, finish?: unknown}} t
 */
function footer(ctx, provider, model, uc, t) {
  const u = uc.usage;
  const served = typeof t.servedModel === 'string' && t.servedModel !== model ? ` (served as ${clean(t.servedModel)})` : '';
  const tokens = u
    ? `${fmtInt(u.prompt_tokens)} prompt (${fmtInt(u.cached_tokens)} cached) / ${fmtInt(u.completion_tokens)} completion`
    : 'not reported';
  const parts = [
    `provider ${clean(provider)}`,
    `model ${clean(model)}${served}`,
    `tokens ${tokens}`,
    `cost ${costWords(uc.cost)}`,
    `ttfb ${fmtMs(t.ttfbMs)}`,
    `total ${fmtMs(t.totalMs)}`,
  ];
  if (typeof t.finish === 'string' && t.finish !== 'stop') parts.push(`finish ${clean(t.finish)}`);
  ctx.stderr.write(`${ctx.ce.dim(parts.join(' · '))}\n`);
}

/** @param {Context} ctx */
async function ask(ctx) {
  const model = typeof ctx.flags.model === 'string' ? ctx.flags.model : DEFAULT_ASK_MODEL;
  const maxTokens = intFlag(ctx.flags['max-tokens'], 'max-tokens', 1, 10_000_000);
  const stream = !ctx.flags['no-stream'];
  const showReasoning = Boolean(ctx.flags['show-reasoning']);
  let prompt = ctx.positionals.join(' ');
  if (!ctx.stdin.isTTY) {
    // Piped input is the prompt, or is appended to the prompt arguments after a blank line.
    const piped = await readStdinText(ctx.stdin);
    if (piped.trim() !== '') prompt = prompt === '' ? piped : `${prompt}\n\n${piped}`;
  } else if (prompt === '') throw usageError('no prompt: pass it as arguments or pipe it on stdin');
  if (prompt.trim() === '') throw usageError('the prompt is empty');
  const client = await ctx.client(CHAT_TIMEOUT_S);
  /** @type {{role: string, content: string}[]} */
  const messages = [];
  if (typeof ctx.flags.system === 'string') messages.push({ role: 'system', content: ctx.flags.system });
  messages.push({ role: 'user', content: prompt });
  const body = {
    model,
    messages,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };

  // Model text reaches a terminal without control characters; pipes get it byte for byte.
  const forStdout = ctx.stdout.isTTY ? terminalSafe : (/** @type {string} */ t) => t;
  const forStderr = ctx.stderr.isTTY ? terminalSafe : (/** @type {string} */ t) => t;

  if (!stream) {
    const { res, json, ttfbMs, totalMs } = await client.request('POST', '/v1/chat/completions', body);
    const provider = res.headers.get('x-router-provider') ?? '';
    const message = json?.choices?.[0]?.message ?? {};
    if (ctx.json) ctx.printJson(json);
    else {
      if (showReasoning && typeof message.reasoning_content === 'string') ctx.stderr.write(`${ctx.ce.dim(forStderr(message.reasoning_content))}\n`);
      const content = typeof message.content === 'string' ? forStdout(message.content) : '';
      ctx.stdout.write(content.endsWith('\n') || content === '' ? content : `${content}\n`);
    }
    footer(ctx, provider, model, requestCost(provider, model, json?.usage), { ttfbMs, totalMs, servedModel: json?.model, finish: json?.choices?.[0]?.finish_reason });
    return;
  }

  const { res, t0 } = await client.open('POST', '/v1/chat/completions', body);
  const provider = res.headers.get('x-router-provider') ?? '';
  let reasoningShown = false;
  let lastChar = '\n';
  const r = await consumeStream(
    res,
    t0,
    {
      onContent: ctx.json
        ? undefined
        : (text) => {
            if (reasoningShown) {
              ctx.stderr.write('\n');
              reasoningShown = false;
            }
            const shown = forStdout(text);
            ctx.stdout.write(shown);
            lastChar = shown.at(-1) ?? lastChar;
          },
      onReasoning:
        ctx.json || !showReasoning
          ? undefined
          : (text) => {
              reasoningShown = true;
              ctx.stderr.write(ctx.ce.dim(forStderr(text)));
            },
    },
    (err) => client.networkError(err),
  );
  if (reasoningShown) ctx.stderr.write('\n');
  if (!ctx.json && lastChar !== '\n') ctx.stdout.write('\n');
  const failure = streamFailure(r, provider);
  if (failure) throw failure;
  if (ctx.json) ctx.printJson(r.response);
  footer(ctx, provider, model, requestCost(provider, model, r.response.usage), { ...r, servedModel: r.response.model, finish: r.response.choices[0].finish_reason });
}

/**
 * One smoke request. Router-level failures (wrong password, blocked source, router unreachable
 * or redirecting) abort the whole run; anything else, including a connection that breaks after
 * the response started, becomes a failed row.
 * @param {ReturnType<typeof createClient>} client @param {string} provider @param {string} model @param {boolean} stream
 */
async function smoke(client, provider, model, stream) {
  const body = {
    model,
    messages: [{ role: 'user', content: SMOKE_PROMPT }],
    max_tokens: SMOKE_MAX_TOKENS,
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
  /** @type {Record<string, any>} */
  const row = { provider, mode: stream ? 'stream' : 'non-stream', model, ok: false, result: 'error', http_status: null, ttfb_ms: null, total_ms: null };
  try {
    let raw;
    if (stream) {
      const { res, t0 } = await client.open('POST', '/v1/chat/completions', body);
      row.http_status = res.status;
      const r = await consumeStream(res, t0, {}, (err) => client.networkError(err));
      Object.assign(row, { ttfb_ms: r.ttfbMs, total_ms: r.totalMs });
      raw = r.response.usage;
      const failure = streamFailure(r, provider);
      if (failure) throw failure;
    } else {
      const r = await client.request('POST', '/v1/chat/completions', body);
      Object.assign(row, { http_status: r.res.status, ttfb_ms: r.ttfbMs, total_ms: r.totalMs });
      raw = r.json?.usage;
    }
    const { usage: u, cost } = requestCost(provider, model, raw);
    Object.assign(row, { ok: true, result: 'ok', usage: u, cost });
  } catch (err) {
    const noResponse = err instanceof CliError && err.exitCode === EXIT.NETWORK && !err.timeout && err.code === undefined;
    if (!(err instanceof CliError) || err.exitCode === EXIT.GATEWAY || noResponse) throw err;
    Object.assign(row, { result: err.timeout ? 'timeout' : (err.code ?? 'error'), http_status: err.status ?? row.http_status, error: err.message });
  }
  return row;
}

/** @param {Context} ctx */
async function test(ctx) {
  const requested = [...new Set(ctx.positionals)];
  for (const p of requested) {
    if (!(/** @type {readonly string[]} */ (PROVIDER_IDS).includes(p))) {
      throw usageError(`unknown provider${SAFE_WORD.test(p) ? ` "${p}"` : ''}; use any of: ${PROVIDER_IDS.join(', ')}`);
    }
  }
  const modelFlag = typeof ctx.flags.model === 'string' ? ctx.flags.model : undefined;
  let modelProvider;
  if (modelFlag !== undefined) {
    try {
      modelProvider = routeModel(modelFlag).provider;
    } catch (err) {
      throw usageError(`--model: ${/** @type {Error} */ (err).message}`);
    }
    if (requested.length > 1 || (requested.length === 1 && requested[0] !== modelProvider)) {
      throw usageError(`--model ${modelFlag} routes to ${modelProvider}; give no provider or only that one`);
    }
  }
  const client = await ctx.client(CHAT_TIMEOUT_S);
  let providers = modelProvider ? [modelProvider] : requested;
  if (!providers.length) {
    const { json: h } = await client.get('/control/health');
    providers = PROVIDER_IDS.filter((id) => h?.providers?.[id]?.configured);
    if (!providers.length) throw new CliError("no provider is configured on the router (see 'mrouter keys list')");
  }
  const rows = [];
  for (const provider of providers) {
    const model = modelFlag ?? SMOKE_MODELS[/** @type {keyof typeof SMOKE_MODELS} */ (provider)];
    for (const stream of [false, true]) rows.push(await smoke(client, provider, model, stream));
  }
  const failed = rows.filter((r) => !r.ok);
  if (ctx.json) {
    ctx.printJson({
      ok: failed.length === 0,
      results: rows.map((r) => ({
        provider: r.provider,
        mode: r.mode,
        model: r.model,
        ok: r.ok,
        result: r.result,
        http_status: r.http_status,
        ttfb_ms: r.ttfb_ms === null ? null : Math.round(r.ttfb_ms),
        total_ms: r.total_ms === null ? null : Math.round(r.total_ms),
        prompt_tokens: r.usage?.prompt_tokens ?? null,
        completion_tokens: r.usage?.completion_tokens ?? null,
        cached_tokens: r.usage?.cached_tokens ?? null,
        cost_usd: r.cost && r.cost.status !== 'unknown' ? r.cost.usd : null,
        cost_status: r.cost?.status ?? 'unknown',
        ...(r.error ? { error: r.error } : {}),
      })),
    });
  } else {
    const table = rows.map((r) => [
      r.provider,
      r.mode,
      clean(r.model),
      r.ok ? { text: 'ok', style: ctx.c.green } : { text: clean(r.result), style: ctx.c.red },
      shown(r.http_status),
      fmtMs(r.ttfb_ms ?? undefined),
      fmtMs(r.total_ms ?? undefined),
      r.usage ? `${fmtInt(r.usage.prompt_tokens)}/${fmtInt(r.usage.completion_tokens)}/${fmtInt(r.usage.cached_tokens)}` : '-',
      r.ok ? costWords(r.cost) : '-',
    ]);
    const columns = [
      { header: 'PROVIDER' },
      { header: 'MODE' },
      { header: 'MODEL' },
      { header: 'RESULT' },
      { header: 'HTTP', right: true },
      { header: 'TTFB', right: true },
      { header: 'TOTAL', right: true },
      { header: 'TOKENS P/C/CACHED', right: true },
      { header: 'COST' },
    ];
    ctx.print(renderTable(columns, table, ctx.c));
    for (const r of failed) ctx.print(`${ctx.c.red(`${r.provider} ${r.mode}`)}: ${r.error}\n`);
  }
  if (failed.length) throw new CliError(`${failed.length} of ${rows.length} checks failed`, EXIT.UPSTREAM);
  if (!ctx.json) ctx.print(`All ${rows.length} checks passed.\n`);
}

// ------------------------------------------------------------------ hash-password

/** @param {Context} ctx */
async function hashPasswordCommand(ctx) {
  noArguments(ctx, PASSWORD_ARGUMENT_REFUSAL);
  const password = ctx.secret(await ctx.readSecret('New router password: ', 'password', { confirm: true }));
  checkPasswordShape(password, 'the password');
  if (password.length < MIN_PASSWORD_LENGTH) throw usageError(`the password must be at least ${MIN_PASSWORD_LENGTH} characters long`);
  const hash = await hashPassword(password);
  if (ctx.json) return ctx.printJson({ ROUTER_PASSWORD_HASH: hash });
  // No newline into a pipe or file, so the value can be stored as is.
  ctx.print(ctx.stdout.isTTY ? `${hash}\n` : hash);
}

// ------------------------------------------------------------------ command table

/**
 * @typedef {import('./args.js').FlagSpec} FlagSpec
 * @typedef {{summary: string, usage: string, synopsis?: string, description?: string, examples?: string[],
 *   flags?: Record<string, FlagSpec>, run?: (ctx: Context) => Promise<unknown>,
 *   subcommands?: Record<string, Command>}} Command
 */

/** @type {Record<string, Command>} */
export const COMMANDS = {
  login: {
    summary: 'Check the router password against the server and store it',
    usage: 'login [--url URL]',
    description:
      'Reads the password from a hidden prompt, or from stdin when piped (never from arguments),\n' +
      'checks it with GET /control/health and only then saves the URL to config.json and the\n' +
      'password to the credentials file (mode 0600). The stored password is only ever sent to\n' +
      'the URL it was saved with.',
    examples: ['mrouter login --url https://router.example.com', 'mrouter login --url https://router.example.com < password-file'],
    run: login,
  },
  logout: { summary: 'Delete the stored password', usage: 'logout', run: logout },
  status: {
    summary: 'Show the URL, whether a password is stored, and the config paths',
    usage: 'status',
    description: 'Local only: no request is sent and the password is never shown.',
    run: status,
  },
  health: { summary: 'Server health: version, instance, store latency, providers', usage: 'health', run: health },
  keys: {
    summary: 'Provider keys stored on the router',
    usage: 'keys <list|set|unset>',
    subcommands: {
      list: { summary: 'Provider, configured, source (store/env/none), last update', usage: 'keys list', run: keysList },
      set: {
        summary: 'Store a provider key on the router and verify it',
        usage: 'keys set <claude|gemini|openrouter> [--no-verify]',
        synopsis: 'keys set <provider>',
        description:
          "Reads the key from a hidden prompt, or from stdin when piped. Keys are never accepted as\n" +
          "arguments. Unless --no-verify, the router first checks it against the provider's model list\n" +
          '(no tokens are spent) and stores it, encrypted, only if the provider accepts it. Exits 4,\n' +
          'with nothing stored, if the provider rejects the key or the check cannot be completed.',
        flags: { 'no-verify': { type: 'boolean', help: 'Store without verifying' } },
        examples: ['mrouter keys set claude', 'mrouter keys set gemini < gemini-key-file'],
        run: keysSet,
      },
      unset: {
        summary: 'Remove a stored key (the environment key applies again)',
        usage: 'keys unset <claude|gemini|openrouter>',
        synopsis: 'keys unset <provider>',
        examples: ['mrouter keys unset openrouter'],
        run: keysUnset,
      },
    },
  },
  models: { summary: 'Models the router has metadata and prices for', usage: 'models', run: models },
  ask: {
    summary: 'Send a prompt; stream the reply, then a usage and cost footer',
    usage: 'ask [-m MODEL] [-s SYSTEM] [--no-stream] [--max-tokens N] [--show-reasoning] [PROMPT...]',
    synopsis: 'ask [PROMPT...]',
    description:
      'The prompt is the arguments joined with spaces. Piped stdin is read to its end and appended\n' +
      'after a blank line (or is the whole prompt without arguments); from a program that leaves\n' +
      'stdin open, pass </dev/null. The reply is written to stdout as it arrives (on a terminal\n' +
      'without control characters); a footer on stderr shows provider, model, tokens, cost (exact,\n' +
      `estimated or unknown) and latency. Default model: ${DEFAULT_ASK_MODEL}; any other with -m.\n` +
      'With --json the assembled response JSON is printed instead of the text. Use -- before a\n' +
      'prompt that starts with -.',
    flags: {
      model: { type: 'string', short: 'm', value: 'MODEL', help: `Model name (default ${DEFAULT_ASK_MODEL})` },
      system: { type: 'string', short: 's', value: 'SYSTEM', help: 'System message' },
      'no-stream': { type: 'boolean', help: 'One non-streaming request' },
      'max-tokens': { type: 'string', value: 'N', help: 'max_tokens for the reply' },
      'show-reasoning': { type: 'boolean', help: 'Print reasoning text (to stderr) when the model returns it' },
    },
    examples: ['mrouter ask "Explain HTTP/2 in one sentence"', 'git diff | mrouter ask -m gemini-2.5-flash "Review this diff:"'],
    run: ask,
  },
  test: {
    summary: 'One non-streaming and one streaming request per provider',
    usage: 'test [claude|gemini|openrouter...] [-m MODEL]',
    synopsis: 'test [provider...]',
    description:
      'Without providers, tests every provider the router has a key for, each with its cheap\n' +
      `default model (${Object.entries(SMOKE_MODELS).map(([p, m]) => `${p}: ${m}`).join(', ')}),\n` +
      `prompt "${SMOKE_PROMPT}" and max_tokens ${SMOKE_MAX_TOKENS}. -m/--model tests that model on the provider it routes\n` +
      'to. Exits 4 if any check fails.',
    flags: { model: { type: 'string', short: 'm', value: 'MODEL', help: 'Model to test instead of the default' } },
    examples: ['mrouter test', 'mrouter test gemini', 'mrouter test -m claude-sonnet-4-6'],
    run: test,
  },
  usage: {
    summary: 'Usage and cost per provider and model',
    usage: 'usage [--days N | --since YYYY-MM-DD]',
    description:
      'UTC days, at most 400 (default: the last 30). Costs are marked: exact (reported by the\n' +
      'provider), est (estimated from the price table), mixed, unknown, or "≥ … partial" when some\n' +
      'requests have no known cost (the sum is then a lower bound).',
    flags: {
      days: { type: 'string', value: 'N', help: 'The last N UTC days, today included (default 30)' },
      since: { type: 'string', value: 'DATE', help: 'From this UTC date (YYYY-MM-DD) to today' },
    },
    examples: ['mrouter usage', 'mrouter usage --days 1', 'mrouter usage --since 2026-10-01 --json'],
    run: usage,
  },
  errors: {
    summary: 'Recent error and authentication events, newest first',
    usage: 'errors [--limit N] [--kind auth|upstream|gateway]',
    flags: {
      limit: { type: 'string', value: 'N', help: 'At most N events, 1-200 (default 50)' },
      kind: { type: 'string', value: 'K', help: 'Only auth, upstream or gateway events' },
    },
    examples: ['mrouter errors --kind auth --limit 10'],
    run: errors,
  },
  'hash-password': {
    summary: 'Print a ROUTER_PASSWORD_HASH value for a new password',
    usage: 'hash-password',
    description:
      'Reads the password from a hidden prompt (asked twice), or from stdin when piped, and prints\n' +
      'the scrypt hash for ROUTER_PASSWORD_HASH on stdout (without a newline unless stdout is a\n' +
      'terminal). Write it to a file first, then give that file to the Vercel CLI on stdin, never\n' +
      'as an argument, as a sensitive environment variable; delete the file afterwards. Piping\n' +
      'straight into `vercel env add` would make two programs read the terminal at once.\n' +
      `Passwords must be at least ${MIN_PASSWORD_LENGTH} printable ASCII characters; use a long random one.`,
    examples: [
      '(umask 077; mrouter hash-password > router-password.hash)',
      'vercel env add ROUTER_PASSWORD_HASH production --sensitive < router-password.hash',
      'rm router-password.hash',
    ],
    run: hashPasswordCommand,
  },
  help: { summary: 'Show help for a command', usage: 'help [command]', synopsis: 'help [command]' },
};
