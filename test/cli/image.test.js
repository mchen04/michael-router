import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { DEFAULT_IMAGE_MODEL } from '../../cli/lib/commands.js';
import { finishCliSuite, makeHome, runCli } from '../helpers/cli.js';

const STUB_ENV = { MROUTER_PASSWORD: 'stub-router-password' };
const PIXEL = Buffer.from('fake-jpeg-bytes');
/** @type {{url: string, server: http.Server}} */
let stub;
/** @type {any[]} */
const bodies = [];

before(async () => {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push({ url: req.url, body });
    res.writeHead(200, { 'content-type': 'application/json', 'x-router-provider': 'openai' });
    const data = Array.from({ length: body.n ?? 1 }, () => ({ b64_json: PIXEL.toString('base64') }));
    res.end(JSON.stringify({ created: 1, output_format: body.output_format ?? 'jpeg', data, usage: { input_tokens: 50, output_tokens: 1000 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  stub = { server, url: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}` };
});
after(async () => {
  stub.server.closeAllConnections();
  await new Promise((resolve) => stub.server.close(resolve));
  await finishCliSuite();
});

test('image writes each returned image to PREFIX-i.ext and reports files, usage and cost', async () => {
  const home = await makeHome();
  const prefix = path.join(home, 'dusk');
  const r = await runCli(['image', '--url', stub.url, '--json', '-n', '2', '--size', '1024x1024', '-o', prefix, 'a', 'lighthouse'], { home, env: STUB_ENV });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(bodies.at(-1), { url: '/v1/images/generations', body: { model: DEFAULT_IMAGE_MODEL, prompt: 'a lighthouse', n: 2, size: '1024x1024' } });
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.files, [`${prefix}-1.jpg`, `${prefix}-2.jpg`]);
  assert.deepEqual(out.cost, { usd: (50 * 2000 + 1000 * 8000) / 1e9, status: 'estimated' });
  assert.deepEqual(await readFile(`${prefix}-2.jpg`), PIXEL);
  const png = await runCli(['image', '--url', stub.url, '--format', 'png', '-o', prefix, 'x'], { home, env: STUB_ENV });
  assert.equal(png.stdout, `${prefix}-1.png\n`);
  assert.match(png.stderr, /provider openai/);
});

test('image refuses non-image models before any request and never overwrites a file', async () => {
  const home = await makeHome();
  const before = bodies.length;
  const refused = await runCli(['image', '--url', stub.url, '-m', 'gpt-6-luna', 'x'], { home, env: STUB_ENV });
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /gpt-image-/);
  assert.equal(bodies.length, before);
  const prefix = path.join(home, 'taken');
  await writeFile(`${prefix}-1.jpg`, 'keep');
  const clash = await runCli(['image', '--url', stub.url, '-o', prefix, 'x'], { home, env: STUB_ENV });
  assert.equal(clash.code, 1);
  assert.match(clash.stderr, /already exists/);
  assert.equal(await readFile(`${prefix}-1.jpg`, 'utf8'), 'keep');
});
