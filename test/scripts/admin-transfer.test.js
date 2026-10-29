import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parsePasswordHash, verifyPassword } from '../../src/auth.js';
import { ADMIN_PASSWORD } from '../helpers/fixtures.js';
import { createFakeTools } from '../helpers/fake-tools.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('admin stdin transfer hashes the password and sends it only to the fake Vercel stdin', async () => {
  const scratch = await mkdtemp(path.join(root, 'test', '.admin-transfer-'));
  try {
    await cp(path.join(root, 'src'), path.join(scratch, 'src'), { recursive: true });
    await mkdir(path.join(scratch, 'scripts', 'lib'), { recursive: true });
    await copyFile(path.join(root, 'scripts', 'copy-keys-to-vercel.mjs'), path.join(scratch, 'scripts', 'copy-keys-to-vercel.mjs'));
    await copyFile(path.join(root, 'scripts', 'lib', 'env-document.mjs'), path.join(scratch, 'scripts', 'lib', 'env-document.mjs'));
    await copyFile(path.join(root, 'package.json'), path.join(scratch, 'package.json'));
    const fake = await createFakeTools(scratch);
    await fake.configure({ vercel: { capture: ['ROUTER_ADMIN_PASSWORD_HASH'] } });
    const manifest = path.join(scratch, 'admin.json');
    await writeFile(manifest, JSON.stringify({ version: 1, environment: 'production', project: { orgId: 'team_TestOwner', projectId: 'prj_TestAdmin' }, entries: [{ env: 'ROUTER_ADMIN_PASSWORD_HASH', source: { type: 'stdin' }, transform: 'scrypt-hash' }] }));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(scratch, 'scripts', 'copy-keys-to-vercel.mjs'), '--manifest', manifest, '--yes'], { env: { HOME: scratch, PATH: `${fake.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` }, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', (part) => { output += part; });
      child.stderr.on('data', (part) => { output += part; });
      child.stdin.end(ADMIN_PASSWORD);
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
    const captured = await fake.captured();
    const hash = parsePasswordHash(captured.ROUTER_ADMIN_PASSWORD_HASH);
    assert.ok(hash);
    assert.equal(await verifyPassword(hash, ADMIN_PASSWORD), true);
    const calls = await fake.calls();
    assert.deepEqual(calls.filter((call) => call.argv[1] === 'add' && call.argv[2] !== '--help').map((call) => call.argv[2]), ['ROUTER_ADMIN_PASSWORD_HASH']);
    assert.ok(!result.output.includes(ADMIN_PASSWORD));
    assert.ok(!JSON.stringify(calls).includes(ADMIN_PASSWORD));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
