// ask, test and usage through the real mrouter binary: streaming order and footer, --json, the
// upstream and network exit codes, the smoke-test table, and the usage cost markers. A small stub
// router covers what the fakes behind a real router cannot produce.
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { DEFAULT_ASK_MODEL, SMOKE_PROMPT } from '../../cli/lib/commands.js';
import { fmtUsd } from '../../cli/lib/output.js';
import { SMOKE_MODELS } from '../../src/pricing.js';
import { PTY_SKIP, finishCliSuite, loggedInHome, plain, runCli, runCliPty, startRouterStack, tableRows, waitForJson } from '../helpers/cli.js';

/** @type {Awaited<ReturnType<typeof startRouterStack>>} */
let stack;
let home = '';
/** @type {{url: string, close: () => Promise<void>}} */
let stub;
/** The stub router takes any password; this one is not a secret. */
const STUB_ENV = { MROUTER_PASSWORD: 'stub-router-password' };
/** Model output carrying terminal controls: OSC title, BEL, C1 CSI, CR, NUL. */
const CONTROL_TEXT = 'A\u001b]0;pwned\u0007B\u009b2JC\rD\u0000E\n';

/**
 * A stand-in router. By model:
 *   claude-stub           reasoning deltas, content, usage and [DONE] (or the same as one JSON reply)
 *   claude-stub-cut       that stream, ended after the first content delta without [DONE]
 *   claude-stub-controls  content and reasoning with terminal control characters
 *   claude-stub-echo      an upstream error whose message echoes the bearer credential
 *   claude-stub-vercel    a Vercel platform error (x-vercel-error, no router headers)
 *   the Claude smoke model, streaming: the connection drops after the first chunk
 *   anything else         a normal reply
 */
async function startStubRouter() {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const model = String(body.model);
    const provider = model.startsWith('gemini-') ? 'gemini' : 'claude';
    if (model === 'claude-stub-vercel') {
      res.writeHead(504, { 'content-type': 'text/plain; charset=utf-8', 'x-vercel-error': 'FUNCTION_INVOCATION_TIMEOUT' });
      return res.end('An error occurred with your deployment\n\nFUNCTION_INVOCATION_TIMEOUT\n');
    }
    if (model === 'claude-stub-echo') {
      const credential = String(req.headers.authorization).replace(/^Bearer /, '');
      res.writeHead(502, { 'content-type': 'application/json', 'x-router-error-source': 'upstream', 'x-router-provider': provider });
      const error = { message: `upstream rejected credential ${credential}`, type: 'upstream_error', code: 'provider_auth_failed', provider, upstream_status: 401 };
      return res.end(JSON.stringify({ error }));
    }
    const controls = model === 'claude-stub-controls';
    const reasoning = controls ? ['R\u0007S'] : ['Thinking it', ' over.'];
    const content = controls ? [CONTROL_TEXT] : ['The answer', ' is 4.'];
    const usage = { prompt_tokens: 10, completion_tokens: 5 };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-router-provider': provider });
      const message = { role: 'assistant', content: content.join(''), reasoning_content: reasoning.join('') };
      return res.end(JSON.stringify({ id: 'stub-1', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message, finish_reason: 'stop' }], usage }));
    }
    /** @param {Record<string, unknown>} delta @param {string | null} [finish] */
    const chunk = (delta, finish = null) =>
      `data: ${JSON.stringify({ id: 'stub-1', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-router-provider': provider });
    if (model === SMOKE_MODELS.claude) {
      return res.write(chunk({ role: 'assistant', content: 'Po' }), () => setTimeout(() => res.socket?.destroy(), 50));
    }
    for (const r of reasoning) res.write(chunk({ reasoning_content: r }));
    res.write(chunk({ content: content[0] }));
    if (model === 'claude-stub-cut') return res.end();
    for (const c of content.slice(1)) res.write(chunk({ content: c }));
    res.write(chunk({}, 'stop'));
    res.write(`data: ${JSON.stringify({ id: 'stub-1', object: 'chat.completion.chunk', created: 1, model, choices: [], usage })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

before(async () => {
  [stack, stub] = await Promise.all([startRouterStack(), startStubRouter()]);
  home = await loggedInHome(stack.url);
});
after(async () => {
  await Promise.all([stack?.stop(), stub?.close()]);
  await finishCliSuite();
});

/** @param {string[]} args @param {Omit<Parameters<typeof runCli>[1], 'home'>} [options] */
const mr = (args, options = {}) => runCli(args, { home, ...options });
const MS = String.raw`(\d+ ms|\d+\.\d\d s)`;
/** The UTC date `days` from today. @param {number} days */
const utcDate = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

test('ask streams the reply to stdout as it arrives; the footer follows on stderr', async () => {
  const r = await mr(['ask', '-m', 'claude-fake-slow-stream', 'Say hello']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'Hello from the fake Claude API.\n');
  const out = r.chunks.filter((c) => c.stream === 'stdout');
  assert.ok(out.length >= 3, 'the reply arrived in several pieces');
  assert.ok(r.exitMs - out[0].ms >= 400, 'the first words were shown well before the end');
  let seen = '';
  const contentDone = /** @type {(typeof out)[number]} */ (out.find((c) => (seen += c.text).includes('Claude API.')));
  const footerAt = /** @type {(typeof out)[number]} */ (r.chunks.find((c) => c.stream === 'stderr'));
  assert.ok(contentDone.ms <= footerAt.ms, 'the footer comes after the content');
  assert.match(
    r.stderr,
    new RegExp(`^provider claude · model claude-fake-slow-stream · tokens 2,500 prompt \\(2,000 cached\\) / 50 completion · cost unknown · ttfb ${MS} · total ${MS}\\n$`),
  );
});

test('ask footers: estimated and exact cost; --json output parses; the default model is the Gemini smoke model', async () => {
  const defaultModel = 'gemini-3.5-flash-lite';
  const def = await mr(['ask', 'hi']);
  assert.equal(def.code, 0, def.stderr);
  assert.equal(stack.fake.requests.at(-1)?.body.model, defaultModel);
  assert.equal(def.stdout, 'Hello from the fake Gemini API.\n');
  // 1,000 uncached x $0.30 + 200 cached x $0.03 + 300 completion x $2.50 per 1M tokens = $0.001056
  assert.equal(def.stderr.split(' · ttfb ')[0], `provider gemini · model ${defaultModel} · tokens 1,200 prompt (200 cached) / 300 completion · cost $0.001056 estimated`);
  assert.equal(DEFAULT_ASK_MODEL, SMOKE_MODELS.gemini, 'the ask default is the Gemini smoke model, not a second literal');

  const claude = await mr(['ask', '-m', 'claude-haiku-5-5', 'hi']);
  assert.equal(claude.code, 0, claude.stderr);
  assert.equal(claude.stdout, 'Hello from the fake Claude API.\n');
  assert.equal(stack.fake.requests.at(-1)?.body.model, 'claude-haiku-5-5');
  assert.match(claude.stderr, /^provider claude · model claude-haiku-5-5 · tokens 2,500 prompt \(2,000 cached\) \/ 50 completion · cost \$0\.000105 estimated · /);

  const or = await mr(['ask', '-m', 'vendor/fake-ok', 'hi']);
  assert.equal(or.stdout, 'Hello from the fake OpenRouter API.\n');
  assert.match(or.stderr, /^provider openrouter · model vendor\/fake-ok · tokens 1,000 prompt \(100 cached\) \/ 200 completion · cost \$0\.001230 exact · /);

  const streamed = await mr(['ask', '--json', '-m', 'gemini-2.5-flash-lite', 'hi']);
  assert.equal(streamed.code, 0, streamed.stderr);
  const s = JSON.parse(streamed.stdout);
  assert.deepEqual([s.object, s.choices[0].message.content, s.choices[0].finish_reason, s.usage.prompt_tokens], ['chat.completion', 'Hello from the fake Gemini API.', 'stop', 1200]);
  assert.match(streamed.stderr, /· cost \$0\.000222 estimated ·/);

  const whole = await mr(['ask', '--json', '--no-stream', '-m', 'claude-haiku-5-5', 'hi']);
  const w = JSON.parse(whole.stdout);
  assert.deepEqual([w.id, w.choices[0].message.content], ['msg_fake_01', 'Hello from the fake Claude API.']);
});

test('ask and test count Gemini hidden thinking tokens and cost exactly as the router records them', async () => {
  const model = 'gemini-3.1-flash-lite';
  stack.fake.setDefaults({ scenario: 'hidden-thoughts' });
  let asked;
  let tested;
  try {
    asked = await mr(['ask', '-m', model, 'hi']);
    tested = await mr(['test', '--model', model, '--json']);
  } finally {
    stack.fake.reset();
  }
  assert.equal(asked.code, 0, asked.stderr);
  assert.equal(tested.code, 0, tested.stderr);
  const usage = await waitForJson(stack.url, '/control/usage?days=1', (u) => u.models.some((/** @type {any} */ m) => m.model === model && m.requests === 3));
  const row = usage.models.find((/** @type {any} */ m) => m.model === model);
  const perRequest = { completion: row.completion_tokens / 3, nusd: Math.round((row.cost_usd * 1e9) / 3) };
  assert.equal(perRequest.completion, 500, 'the 200 thinking tokens left out of completion_tokens are billed');
  assert.match(asked.stderr, new RegExp(`· tokens 1,200 prompt \\(200 cached\\) / 500 completion · cost \\${fmtUsd(perRequest.nusd / 1e9)} estimated ·`));
  for (const r of JSON.parse(tested.stdout).results) {
    assert.deepEqual([r.completion_tokens, Math.round(r.cost_usd * 1e9)], [perRequest.completion, perRequest.nusd]);
  }
});

test('ask reads the prompt from stdin, or appends piped stdin to the prompt arguments; -s and --max-tokens are sent', async () => {
  const r = await mr(['ask', '-m', 'gemini-2.5-flash', '-s', 'Be brief.', '--max-tokens', '77'], { input: 'What is 2+2?\n' });
  assert.equal(r.code, 0, r.stderr);
  const body = stack.fake.requests.at(-1)?.body;
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'What is 2+2?' },
  ]);
  assert.deepEqual([body.max_tokens, body.stream], [77, true]);
  const both = await mr(['ask', '-m', 'gemini-2.5-flash', 'Summarize', 'this:'], { input: 'line one\nline two\n' });
  assert.equal(both.code, 0, both.stderr);
  assert.deepEqual(stack.fake.requests.at(-1)?.body.messages, [{ role: 'user', content: 'Summarize this:\n\nline one\nline two' }]);
  const empty = await mr(['ask'], { input: ' \n' });
  assert.deepEqual([empty.code, empty.stderr], [2, 'mrouter: the prompt is empty\n']);
  const bad = await mr(['ask', '--max-tokens', 'many', 'hi']);
  assert.deepEqual([bad.code, bad.stderr], [2, 'mrouter: --max-tokens must be an integer from 1 to 10000000\n']);
});

test('ask failures: upstream errors exit 4 with provider, status, code and message; timeouts exit 5', async () => {
  const limited = await mr(['ask', '-m', 'claude-fake-429', 'hi']);
  assert.deepEqual([limited.code, limited.stdout], [4, '']);
  assert.equal(limited.stderr, 'mrouter: upstream error from claude (HTTP 429, provider_rate_limited): fake 429 error. Retry after 7 s.\n');

  const badKey = await mr(['ask', '--no-stream', '-m', 'claude-fake-invalid-key', 'hi']);
  assert.equal(badKey.code, 4);
  assert.match(badKey.stderr, /^mrouter: upstream error from claude \(HTTP 502, provider answered 401, provider_auth_failed\): The claude API rejected the router's API key/);

  const mid = await mr(['ask', '-m', 'gemini-fake-midstream-error', 'hi']);
  assert.deepEqual([mid.code, mid.stdout], [4, 'Hello\n']);
  assert.equal(mid.stderr, 'mrouter: upstream error from gemini during the stream (INTERNAL): Upstream provider error\n');

  const echoed = await mr(['ask', '-m', 'claude-fake-echo-auth', 'hi']);
  assert.equal(echoed.code, 4);
  assert.match(echoed.stderr, /during the stream \(overloaded_error\): stream failed for key \[redacted\]\n$/);

  const unroutable = await mr(['ask', '-m', 'gpt-5', 'hi']);
  assert.equal(unroutable.code, 1);
  assert.match(unroutable.stderr, /^mrouter: router refused the request \(HTTP 400, model_not_routable\): Model "gpt-5" is not routable\./);

  const slow = await mr(['ask', '--timeout', '0.5', '-m', 'claude-fake-slow-first-byte', 'hi']);
  assert.equal(slow.code, 5);
  assert.match(slow.stderr, /^mrouter: no complete response from http:\/\/127\.0\.0\.1:\d+ within 0\.5 s \(use --timeout to change\)\n$/);
  assert.ok(slow.exitMs < 1900, 'gave up at the timeout, not when the reply came');
});

test('ask: reasoning is hidden unless --show-reasoning (then on stderr); --json keeps it; a cut stream exits 5', async () => {
  const opts = { env: STUB_ENV };
  const plain = await mr(['ask', '--url', stub.url, '-m', 'claude-stub', 'q'], opts);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(plain.stdout, 'The answer is 4.\n');
  assert.match(plain.stderr, /^provider claude · model claude-stub · tokens 10 prompt \(0 cached\) \/ 5 completion · cost unknown · [^\n]+\n$/);

  const shown = await mr(['ask', '--url', stub.url, '--show-reasoning', '-m', 'claude-stub', 'q'], opts);
  assert.equal(shown.stdout, 'The answer is 4.\n');
  assert.match(shown.stderr, /^Thinking it over\.\nprovider claude · /);

  const json = JSON.parse((await mr(['ask', '--url', stub.url, '--json', '-m', 'claude-stub', 'q'], opts)).stdout);
  assert.deepEqual(json.choices[0].message, { role: 'assistant', content: 'The answer is 4.', reasoning_content: 'Thinking it over.' });

  const cut = await mr(['ask', '--url', stub.url, '-m', 'claude-stub-cut', 'q'], opts);
  assert.deepEqual([cut.code, cut.stdout], [5, 'The answer\n']);
  assert.equal(cut.stderr, 'mrouter: the stream ended without [DONE]; the response is incomplete\n');

  const platform = await mr(['ask', '--url', stub.url, '-m', 'claude-stub-vercel', 'q'], opts);
  assert.deepEqual(
    [platform.code, platform.stderr],
    [1, 'mrouter: Vercel platform error (HTTP 504, FUNCTION_INVOCATION_TIMEOUT): the hosting platform answered, not the router\n'],
  );
});

test('ask output keeps control characters through a pipe and drops them on a terminal', async () => {
  const args = ['ask', '--url', stub.url, '--show-reasoning', '-m', 'claude-stub-controls', 'q'];
  const piped = await mr(args, { env: STUB_ENV });
  assert.equal(piped.code, 0, piped.stderr);
  assert.equal(piped.stdout, CONTROL_TEXT);
  assert.ok(piped.stderr.startsWith('R\u0007S\n'));
});

test('ask on a terminal: model output and reasoning lose C0/C1 controls (except newline and tab)', { skip: PTY_SKIP }, async () => {
  const r = await runCliPty(['ask', '--url', stub.url, '--no-color', '--show-reasoning', '-m', 'claude-stub-controls', 'q'], { home, env: STUB_ENV });
  assert.equal(r.code, 0, r.output);
  assert.doesNotMatch(r.output, /[\u0000\u0007\u001b\u009b]/);
  assert.ok(plain(r.output).startsWith('RS\nA]0;pwnedB2JCDE\nprovider claude · '), JSON.stringify(r.output));
});

test('test: a connection that breaks mid-stream fails that row only; the other checks still run', async () => {
  const broken = await mr(['test', '--url', stub.url, 'claude', 'gemini'], { env: STUB_ENV });
  assert.equal(broken.code, 4);
  assert.equal(broken.stderr, 'mrouter: 1 of 4 checks failed\n');
  const rows = tableRows(broken.stdout);
  assert.deepEqual(
    rows.slice(1, 5).map((x) => [x[0], x[1], x[3], x[4]]),
    [
      ['claude', 'non-stream', 'ok', '200'],
      ['claude', 'stream', 'connection_broken', '200'],
      ['gemini', 'non-stream', 'ok', '200'],
      ['gemini', 'stream', 'ok', '200'],
    ],
  );
  assert.match(broken.stdout, /^claude stream: the connection to http:\/\/127\.0\.0\.1:\d+ broke before the response was complete$/m);
});

test('test: failure text in the table and in --json is scrubbed of the password', async () => {
  const env = { MROUTER_PASSWORD: 'pw-SENTINEL-stub-echo-0042' };
  const echoed = await mr(['test', '--url', stub.url, '--model', 'claude-stub-echo'], { env });
  assert.equal(echoed.code, 4);
  assert.match(echoed.stdout, /^claude non-stream: upstream error from claude \(HTTP 502, provider answered 401, provider_auth_failed\): upstream rejected credential \[redacted\]\.$/m);
  const json = await mr(['test', '--url', stub.url, '--model', 'claude-stub-echo', '--json'], { env });
  const errors = JSON.parse(json.stdout).results.map((/** @type {any} */ x) => x.error);
  assert.equal(errors.length, 2);
  for (const e of errors) assert.match(e, /upstream rejected credential \[redacted\]/);
});

test('test: one non-streaming and one streaming check per configured provider, with the cheap smoke models', async () => {
  stack.fake.reset();
  const r = await mr(['test']);
  assert.equal(r.code, 0, r.stderr);
  const [header, ...rows] = tableRows(r.stdout);
  assert.deepEqual(header, ['PROVIDER', 'MODE', 'MODEL', 'RESULT', 'HTTP', 'TTFB', 'TOTAL', 'TOKENS P/C/CACHED', 'COST']);
  assert.equal(rows.pop()?.join(' '), 'All 6 checks passed.');
  const expected = [
    ['claude', 'claude-haiku-5-5', '2,500/50/2,000', '$0.000105 estimated'],
    ['gemini', 'gemini-3.5-flash-lite', '1,200/300/200', '$0.001056 estimated'],
    ['openrouter', 'google/gemini-2.5-flash-lite', '1,000/200/100', '$0.001230 exact'],
  ];
  assert.equal(rows.length, 6);
  rows.forEach((row, i) => {
    const [provider, model, tokens, cost] = expected[Math.floor(i / 2)];
    assert.deepEqual([row[0], row[1], row[2], row[3], row[4], row[7], row[8]], [provider, i % 2 ? 'stream' : 'non-stream', model, 'ok', '200', tokens, cost]);
    assert.match(row[5], /^\d+ ms$/);
  });
  const sent = stack.fake.requests.filter((q) => q.method === 'POST');
  assert.equal(sent.length, 6);
  for (const q of sent) {
    assert.equal(q.body.max_tokens, 256);
    assert.ok(JSON.stringify(q.body.messages).includes(SMOKE_PROMPT));
  }
  assert.deepEqual(sent.map((q) => Boolean(q.body.stream)), [false, true, false, true, false, true]);
  assert.deepEqual(sent.map((q) => q.body.model), expected.flatMap(([, model]) => [model, model]), 'each check sends its smoke model');
});

test('test: a provider with a rejected key fails its rows; exit 4 and the failures listed', async () => {
  assert.equal((await mr(['keys', 'set', 'openrouter', '--no-verify'], { input: 'sk-or-fake-revoked-SENTINEL-0021\n' })).code, 0);
  try {
    const r = await mr(['test']);
    assert.equal(r.code, 4);
    assert.equal(r.stderr, 'mrouter: 2 of 6 checks failed\n');
    const rows = tableRows(r.stdout);
    for (const row of rows.filter((x) => x[0] === 'openrouter')) assert.deepEqual(row.slice(3), ['provider_auth_failed', '502', '-', '-', '-', '-']);
    assert.equal(rows.filter((x) => x[3] === 'ok').length, 4);
    assert.match(r.stdout, /^openrouter non-stream: upstream error from openrouter \(HTTP 502, provider answered 401, provider_auth_failed\): /m);
    assert.match(r.stdout, /^openrouter stream: upstream error from openrouter \(HTTP 502, /m);

    const json = await mr(['test', 'openrouter', '--json']);
    assert.equal(json.code, 4);
    const body = JSON.parse(json.stdout);
    assert.equal(body.ok, false);
    assert.deepEqual(
      body.results.map((/** @type {any} */ x) => [x.provider, x.mode, x.ok, x.result, x.http_status, x.cost_usd, x.cost_status]),
      [
        ['openrouter', 'non-stream', false, 'provider_auth_failed', 502, null, 'unknown'],
        ['openrouter', 'stream', false, 'provider_auth_failed', 502, null, 'unknown'],
      ],
    );
  } finally {
    assert.equal((await mr(['keys', 'unset', 'openrouter'])).code, 0);
  }
});

test('test -m/--model checks one model on the provider it routes to; bad provider or model arguments exit 2', async () => {
  const r = await mr(['test', '-m', 'gemini-2.5-flash', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const body = JSON.parse(r.stdout);
  assert.deepEqual(
    body.results.map((/** @type {any} */ x) => [x.provider, x.mode, x.model, x.ok, x.cost_usd, x.cost_status]),
    [
      ['gemini', 'non-stream', 'gemini-2.5-flash', true, 0.001056, 'estimated'],
      ['gemini', 'stream', 'gemini-2.5-flash', true, 0.001056, 'estimated'],
    ],
  );
  for (const [args, stderr] of [
    [['test', 'anthropic'], /^mrouter: unknown provider "anthropic"; use any of: claude, gemini, openrouter\n$/],
    [['test', 'claude', '--model', 'gemini-2.5-flash'], /^mrouter: --model gemini-2\.5-flash routes to gemini; give no provider or only that one\n$/],
    [['test', '--model', 'gpt-5'], /^mrouter: --model: Model "gpt-5" is not routable\./],
  ]) {
    const e = await mr(/** @type {string[]} */ (args));
    assert.equal(e.code, 2);
    assert.match(e.stderr, /** @type {RegExp} */ (stderr));
  }
});

test('usage: per-model rows marked exact / est / unknown / ≥ partial, a totals row, and --json', async () => {
  for (const m of ['vendor/usage-fake-ok', 'claude-opus-4-6', 'claude-usage-fake-ok', 'gemini-2.5-pro']) {
    const r = await mr(['ask', '-m', m, 'hi']);
    assert.equal(r.code, 0, r.stderr);
  }
  stack.fake.setDefaults({ scenario: 'no-usage' });
  try {
    const r = await mr(['ask', '--no-stream', '-m', 'gemini-2.5-pro', 'hi']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /^provider gemini · model gemini-2\.5-pro · tokens not reported · cost unknown · /);
  } finally {
    stack.fake.reset();
  }
  await waitForJson(stack.url, '/control/usage?days=1', (u) => {
    const byModel = Object.fromEntries(u.models.map((/** @type {any} */ m) => [m.model, m.requests]));
    return byModel['gemini-2.5-pro'] === 2 && byModel['vendor/usage-fake-ok'] === 1 && byModel['claude-opus-4-6'] === 1 && byModel['claude-usage-fake-ok'] === 1;
  });

  const r = await mr(['usage', '--days', '1']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Usage (\d{4}-\d\d-\d\d) to \1 \(1 UTC day\)\n/);
  const rows = tableRows(r.stdout);
  assert.deepEqual(rows[1], ['PROVIDER', 'MODEL', 'REQUESTS', 'ERRORS', 'PROMPT', 'COMPLETION', 'CACHED', 'COST']);
  /** @param {string} model */
  const row = (model) => rows.find((x) => x[1] === model);
  assert.deepEqual(row('vendor/usage-fake-ok'), ['openrouter', 'vendor/usage-fake-ok', '1', '0', '1,000', '200', '100', '$0.001230 exact']);
  assert.deepEqual(row('claude-opus-4-6'), ['claude', 'claude-opus-4-6', '1', '0', '2,500', '50', '2,000', '$0.005250 est']);
  assert.deepEqual(row('claude-usage-fake-ok'), ['claude', 'claude-usage-fake-ok', '1', '0', '2,500', '50', '2,000', 'unknown']);
  assert.deepEqual(row('gemini-2.5-pro'), ['gemini', 'gemini-2.5-pro', '2', '0', '1,200', '300', '200', '≥ $0.004275 partial']);
  const total = /** @type {string[]} */ (rows.find((x) => x[0] === 'total'));
  assert.match(/** @type {string} */ (total.at(-1)), /^≥ \$\d+\.\d+ partial$/);
  assert.match(r.stdout, /\ncost: exact = reported by the provider, est = .*; \d+ requests? reported no usage\.\n$/);

  const json = JSON.parse((await mr(['usage', '--days', '1', '--json'])).stdout);
  const status = Object.fromEntries(json.models.map((/** @type {any} */ m) => [m.model, m.cost_status]));
  assert.deepEqual(
    ['vendor/usage-fake-ok', 'claude-opus-4-6', 'claude-usage-fake-ok', 'gemini-2.5-pro'].map((m) => status[m]),
    ['exact', 'estimated', 'unknown', 'partial'],
  );
  assert.equal(json.totals.cost_status, 'partial');
  assert.ok(json.totals.usage_missing >= 1);
  assert.equal(JSON.parse((await mr(['usage', '--since', json.to, '--json'])).stdout).days, 1);

  for (const [args, stderr] of [
    [['usage', '--days', '0'], 'mrouter: --days must be an integer from 1 to 400\n'],
    [['usage', '--days', '2', '--since', '2026-10-01'], 'mrouter: use either --days or --since, not both\n'],
    [['usage', '--since', '10/01/2026'], 'mrouter: --since must be a date in YYYY-MM-DD form\n'],
    [['usage', '--since', '2026-02-30'], 'mrouter: --since must be a date in YYYY-MM-DD form\n'],
    [['usage', '--since', utcDate(1)], 'mrouter: --since must not be in the future\n'],
    [['usage', '--since', utcDate(-400)], 'mrouter: --since must be at most 400 days ago (inclusive)\n'],
  ]) {
    const e = await mr(/** @type {string[]} */ (args));
    assert.deepEqual([e.code, e.stderr], [2, stderr]);
  }
});
