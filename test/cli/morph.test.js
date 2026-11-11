import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { makeHome, finishCliSuite, runCli } from '../helpers/cli.js';
import { ADMIN_PASSWORD, baseEnv } from '../helpers/fixtures.js';
import { startDevServer } from '../helpers/processes.js';

const key = 'fake-SENTINEL-morph-cli-123456';

test('included and legacy CLI aliases use only a local fake upstream', async () => {
  const home = await makeHome();
  const requests = [];
  let failure = null;
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const bytes of req) raw += bytes;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ path: req.url, body, auth: req.headers.authorization });
    res.setHeader('content-type', body?.stream ? 'text/event-stream' : 'application/json');
    if (req.method === 'GET') return res.end('{"object":"list","data":[]}');
    if (failure === 'http') {
      res.statusCode = 503;
      return res.end(JSON.stringify({ error: { message: 'Temporarily unavailable', code: 'provider_error' } }));
    }
    if (failure === 'stream') return res.end(`data: ${JSON.stringify({ error: { message: 'Temporarily unavailable', code: 'provider_error' } })}\n\n`);
    const usage = { prompt_tokens: 10, completion_tokens: 2 };
    const choices = [{ index: 0, message: { role: 'assistant', content: 'pong' }, delta: { content: 'pong' }, finish_reason: 'stop' }];
    const result = { id: 'fake', model: 'upstream-alias', choices, usage };
    res.end(body.stream ? `data: ${JSON.stringify(result)}\n\ndata: [DONE]\n\n` : JSON.stringify(result));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const router = await startDevServer(await baseEnv({ MORPH_BASE_URL: `http://127.0.0.1:${upstream.address().port}` }));
  const env = { MROUTER_URL: router.url, MROUTER_ADMIN_PASSWORD: ADMIN_PASSWORD };
  try {
    for (const alias of ['included', 'morph']) {
      const set = await runCli(['keys', 'set', alias], { home, env, input: key });
      assert.equal(set.code, 0, set.stderr);
      assert.match(set.stdout, /Stored the included key/);
      assert.doesNotMatch(set.stdout + set.stderr, /morph/i);
    }
    assert.equal(requests[0].path, '/v1/models');
    const listed = await runCli(['keys', 'list', '--json'], { home, env });
    assert.equal(JSON.parse(listed.stdout).find((row) => row.provider === 'morph').source, 'store');
    for (const model of ['kimi-k3.1-pro', 'deepseek-v4.1-flash', 'morph-kimik31', 'morph-dsv41flash', 'automatic']) {
      for (const flags of [[], ['--no-stream']]) {
        const r = await runCli(['ask', '-m', model, '--json', ...flags, 'ping'], { home, env });
        assert.equal(r.code, 0, r.stderr);
        assert.equal(JSON.parse(r.stdout).model, model === 'automatic' ? 'deepseek-v4.1-flash' : model);
        assert.equal(JSON.parse(r.stdout).choices[0].message.content, 'pong');
        assert.match(r.stderr, /cost \$0/);
        assert.match(r.stderr, /provider included/);
        const request = requests.at(-1);
        assert.equal(request.body.model, ['kimi-k3.1-pro', 'morph-kimik31'].includes(model) ? 'morph-kimik31' : 'morph-dsv41flash');
        if (!model.startsWith('morph-')) assert.doesNotMatch(r.stdout + r.stderr, /morph/i);
      }
    }
    assert.equal(requests.length, 12);
    assert.ok(requests.every((request) => request.auth === `Bearer ${key}`));
    const denied = await runCli(['ask', '-m', 'morph-paid', 'ping'], { home, env });
    assert.equal(denied.code, 1);
    assert.equal(requests.length, 12);
    assert.doesNotMatch(denied.stdout + denied.stderr, /morph/i);
    for (const alias of ['included', 'morph']) {
      const checked = await runCli(['test', alias, '--json'], { home, env });
      assert.equal(checked.code, 0, checked.stderr);
      assert.deepEqual(JSON.parse(checked.stdout).results.map((row) => [row.provider, row.model, row.ok]), [
        ['morph', 'deepseek-v4.1-flash', true],
        ['morph', 'deepseek-v4.1-flash', true],
      ]);
      assert.doesNotMatch(checked.stderr, /morph/i);
    }
    for (const command of [['health'], ['health', '--json'], ['keys', 'list'], ['keys', 'list', '--json'], ['models'], ['models', '--json'], ['usage'], ['usage', '--json']]) {
      const result = await runCli(command, { home, env });
      assert.equal(result.code, 0, result.stderr);
      if (!command.includes('--json')) assert.doesNotMatch(result.stdout + result.stderr, /\bprovider morph\b/);
      if (command[0] === 'health' && command.includes('--json')) {
        assert.deepEqual(JSON.parse(result.stdout).providers.morph, { configured: true });
        assert.equal(Object.hasOwn(JSON.parse(result.stdout).providers, 'included'), false);
      }
    }
    for (const mode of ['http', 'stream']) {
      failure = mode;
      const result = await runCli(['ask', '-m', 'deepseek-v4.1-flash', ...(mode === 'http' ? ['--no-stream'] : []), 'ping'], { home, env });
      assert.equal(result.code, 4, result.stderr);
      assert.match(result.stderr, /upstream error from included/);
      assert.doesNotMatch(result.stdout + result.stderr, /morph/i);
    }
    for (const alias of ['included', 'morph']) {
      const unset = await runCli(['keys', 'unset', alias], { home, env });
      assert.equal(unset.code, 0, unset.stderr);
      assert.doesNotMatch(unset.stdout + unset.stderr, /morph/i);
    }
  } finally {
    await router.stop();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await finishCliSuite();
  }
});

test('CLI JSON preserves server provider IDs for control and catalog replies', async () => {
  const home = await makeHome();
  const calls = [];
  const keyInfo = { provider: 'morph', configured: true, source: 'store', updated_at: null };
  const responses = {
    '/control/health': { status: 'ok', providers: { morph: { configured: true } } },
    '/control/keys': [keyInfo],
    '/control/keys/morph': keyInfo,
    '/control/usage?days=30': { models: [{ provider: 'morph', model: 'kimi-k3.1-pro' }], providers: [{ provider: 'morph' }] },
    '/control/errors?limit=50': [{ provider: 'morph', message: 'see https://api.morphllm.com/docs' }],
    '/v1/models': { object: 'list', data: [{ id: 'kimi-k3.1-pro', owned_by: 'included' }] },
  };
  const server = createServer(async (req, res) => {
    for await (const bytes of req) void bytes;
    calls.push([req.method, req.url]);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(responses[req.url]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = { MROUTER_URL: `http://127.0.0.1:${server.address().port}`, MROUTER_ADMIN_PASSWORD: ADMIN_PASSWORD };
  try {
    for (const [args, method, endpoint] of [
      [['health'], 'GET', '/control/health'],
      [['keys', 'list'], 'GET', '/control/keys'],
      [['keys', 'set', 'included', '--no-verify'], 'PUT', '/control/keys/morph'],
      [['keys', 'unset', 'included'], 'DELETE', '/control/keys/morph'],
      [['usage'], 'GET', '/control/usage?days=30'],
      [['errors'], 'GET', '/control/errors?limit=50'],
      [['models'], 'GET', '/v1/models'],
    ]) {
      const result = await runCli([...args, '--json'], { home, env, input: key });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), responses[endpoint]);
      assert.deepEqual(calls.at(-1), [method, endpoint]);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await finishCliSuite();
  }
});
