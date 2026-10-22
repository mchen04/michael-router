import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { VERSION, shortCommit } from '../../src/version.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));

test('version comes from package.json; commit is the short VERCEL_GIT_COMMIT_SHA', () => {
  assert.equal(VERSION, pkg.version);
  assert.equal(shortCommit('0123456789abcdef0123456789abcdef01234567'), '0123456');
  assert.equal(shortCommit(undefined), null);
  assert.equal(shortCommit('not-a-sha'), null);
});

test('package.json and vercel.json match DESIGN §2/§11', () => {
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, '24.x');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@vercel/functions', 'pg']);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(vercel.framework, null);
  assert.equal(vercel.outputDirectory, 'public');
  assert.equal(vercel.buildCommand, '');
  assert.deepEqual(vercel.regions, ['cle1'], 'the function runs next to the database (DEPLOY.md step 5.1)');
  assert.deepEqual(vercel.rewrites, [
    { source: '/v1/:path*', destination: '/api/router?__route=v1/:path*' },
    { source: '/control/:path*', destination: '/api/router?__route=control/:path*' },
  ]);
  assert.deepEqual(vercel.functions['api/router.js'], { maxDuration: 300, supportsCancellation: true });
});

test('api/router.js exports a Web fetch handler', async () => {
  const mod = await import('../../api/router.js');
  assert.equal(typeof mod.default.fetch, 'function');
});
