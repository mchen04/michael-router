import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { makeHome, finishCliSuite, runCli } from '../helpers/cli.js';
import { baseEnv, ADMIN_PASSWORD, PASSWORD } from '../helpers/fixtures.js';
import { startDevServer } from '../helpers/processes.js';

const key = 'sk-fake-SENTINEL-openai-smoke';

test('OpenAI keys set/list/unset, CLI chat and live smoke use only the local fake provider', async () => {
  const home = await makeHome();
  const requests = [];
  const upstream = createServer(async (req, res) => {
    let text = '';
    for await (const bytes of req) text += bytes;
    const body = text ? JSON.parse(text) : null;
    requests.push({ path: req.url, body, auth: req.headers.authorization });
    res.setHeader('content-type', body?.stream ? 'text/event-stream' : 'application/json');
    const usage = { prompt_tokens: 10, completion_tokens: 2 };
    const choices = [{ index: 0, message: { role: 'assistant', content: 'pong' }, delta: { content: 'pong' }, finish_reason: 'stop' }];
    if (req.method === 'GET') return res.end('{"object":"list","data":[]}');
    if (body.stream) return res.end(`data: ${JSON.stringify({ choices, usage })}\n\ndata: [DONE]\n\n`);
    res.end(JSON.stringify({ id: 'fake', model: body.model, choices, usage }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const router = await startDevServer(await baseEnv({ OPENAI_BASE_URL: `http://127.0.0.1:${upstream.address().port}` }));
  const env = { MROUTER_URL: router.url, MROUTER_ADMIN_PASSWORD: ADMIN_PASSWORD };
  try {
    const set = await runCli(['keys', 'set', 'openai'], { home, env, input: key });
    assert.equal(set.code, 0, set.stderr);
    assert.equal(requests[0].path, '/v1/models');
    const listed = await runCli(['--json', 'keys', 'list'], { home, env });
    assert.equal(JSON.parse(listed.stdout).find((row) => row.provider === 'openai').source, 'store');
    const ask = await runCli(['ask', '-m', 'gpt-6-luna', 'ping'], { home, env });
    assert.equal(ask.code, 0, ask.stderr);
    assert.match(ask.stdout, /pong/);
    const out = path.join(home, 'smoke.json');
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/live-smoke.mjs', '--url', router.url, '--providers', 'openai', '--out', out], { env: { HOME: home, MR_ADMIN_PASSWORD: ADMIN_PASSWORD }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (data) => { stderr += data; });
      child.stdin.end(PASSWORD);
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    const evidence = JSON.parse(await readFile(out, 'utf8'));
    assert.deepEqual(evidence.calls.map((call) => [call.provider, call.model, call.mode, call.ok]), [['openai', 'gpt-6-luna', 'non-stream', true], ['openai', 'gpt-6-luna', 'stream', true]]);
    assert.ok(requests.every((request) => request.auth === `Bearer ${key}`));
    const unset = await runCli(['keys', 'unset', 'openai'], { home, env });
    assert.equal(unset.code, 0, unset.stderr);
    assert.ok(![set.stdout, set.stderr, listed.stdout, ask.stdout, result.stderr, JSON.stringify(evidence)].join('').includes(key));
  } finally {
    await router.stop();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await finishCliSuite();
  }
});
