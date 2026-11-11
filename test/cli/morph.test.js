import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { makeHome, finishCliSuite, runCli } from '../helpers/cli.js';
import { ADMIN_PASSWORD, baseEnv } from '../helpers/fixtures.js';
import { startDevServer } from '../helpers/processes.js';

const key = 'fake-SENTINEL-morph-cli-123456';

test('Morph CLI keys, included models, and automatic use only a local fake upstream', async () => {
  const home = await makeHome();
  const requests = [];
  const upstream = createServer(async (req, res) => {
    let raw = '';
    for await (const bytes of req) raw += bytes;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ path: req.url, body, auth: req.headers.authorization });
    res.setHeader('content-type', body?.stream ? 'text/event-stream' : 'application/json');
    if (req.method === 'GET') return res.end('{"object":"list","data":[]}');
    const usage = { prompt_tokens: 10, completion_tokens: 2 };
    const choices = [{ index: 0, message: { role: 'assistant', content: 'pong' }, delta: { content: 'pong' }, finish_reason: 'stop' }];
    const result = { id: 'fake', model: 'upstream-alias', choices, usage };
    res.end(body.stream ? `data: ${JSON.stringify(result)}\n\ndata: [DONE]\n\n` : JSON.stringify(result));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const router = await startDevServer(await baseEnv({ MORPH_BASE_URL: `http://127.0.0.1:${upstream.address().port}` }));
  const env = { MROUTER_URL: router.url, MROUTER_ADMIN_PASSWORD: ADMIN_PASSWORD };
  try {
    const set = await runCli(['keys', 'set', 'morph'], { home, env, input: key });
    assert.equal(set.code, 0, set.stderr);
    assert.equal(requests[0].path, '/v1/models');
    const listed = await runCli(['keys', 'list', '--json'], { home, env });
    assert.equal(JSON.parse(listed.stdout).find((row) => row.provider === 'morph').source, 'store');
    for (const model of ['morph-kimik31', 'morph-dsv41flash', 'automatic']) {
      for (const flags of [[], ['--no-stream']]) {
        const r = await runCli(['ask', '-m', model, '--json', ...flags, 'ping'], { home, env });
        assert.equal(r.code, 0, r.stderr);
        assert.equal(JSON.parse(r.stdout).model, model === 'automatic' ? 'morph-dsv41flash' : model);
        assert.equal(JSON.parse(r.stdout).choices[0].message.content, 'pong');
        assert.match(r.stderr, /cost \$0/);
      }
    }
    assert.equal(requests.length, 7);
    assert.ok(requests.every((request) => request.auth === `Bearer ${key}`));
    const denied = await runCli(['ask', '-m', 'morph-paid', 'ping'], { home, env });
    assert.equal(denied.code, 1);
    assert.equal(requests.length, 7);
    const unset = await runCli(['keys', 'unset', 'morph'], { home, env });
    assert.equal(unset.code, 0, unset.stderr);
  } finally {
    await router.stop();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await finishCliSuite();
  }
});
