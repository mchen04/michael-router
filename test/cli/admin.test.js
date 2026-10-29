import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { ADMIN_PASSWORD, PASSWORD } from '../helpers/fixtures.js';
import { configDir, finishCliSuite, makeHome, runCli } from '../helpers/cli.js';

test('CLI uses a distinct admin credential for control and the user credential for chat', async () => {
  const home = await makeHome();
  const seen = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req) {}
    seen.push([req.url, req.headers.authorization]);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/control/health') return res.end('{"status":"ok"}');
    res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const env = { MROUTER_URL: url, MROUTER_PASSWORD: PASSWORD, MROUTER_ADMIN_PASSWORD: ADMIN_PASSWORD };
  try {
    const health = await runCli(['health'], { home, env });
    assert.equal(health.code, 0, health.stderr);
    const chat = await runCli(['ask', '--no-stream', '-m', 'gpt-6-luna', 'ping'], { home, env });
    assert.equal(chat.code, 0, chat.stderr);
    assert.deepEqual(seen, [['/control/health', `Bearer ${ADMIN_PASSWORD}`], ['/v1/chat/completions', `Bearer ${PASSWORD}`]]);
    const login = await runCli(['login', '--url', url], { home, input: ADMIN_PASSWORD });
    assert.equal(login.code, 0, login.stderr);
    await writeFile(path.join(configDir(home), 'credentials'), PASSWORD, { mode: 0o600 });
    const owner = await runCli(['health'], { home });
    assert.equal(owner.code, 0, owner.stderr);
    assert.deepEqual(seen.at(-1), ['/control/health', `Bearer ${ADMIN_PASSWORD}`]);
    const brokenHome = await makeHome();
    const brokenDir = configDir(brokenHome);
    await mkdir(path.join(brokenDir, 'config.json'), { recursive: true });
    const oldCredential = path.join(brokenDir, 'admin-credentials');
    await writeFile(oldCredential, 'old-owner-SENTINEL-password', { mode: 0o600 });
    const failedLogin = await runCli(['login', '--url', url], { home: brokenHome, input: ADMIN_PASSWORD });
    assert.notEqual(failedLogin.code, 0);
    await assert.rejects(access(oldCredential), { code: 'ENOENT' });
    const count = seen.length;
    const missing = await runCli(['keys', 'list'], { home: await makeHome(), env: { MROUTER_URL: url, MROUTER_PASSWORD: PASSWORD } });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /no admin password/);
    assert.equal(seen.length, count);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await finishCliSuite();
  }
});
