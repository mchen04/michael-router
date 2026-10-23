// test/helpers/postgres.js: where a PostgreSQL socket directory goes, without starting a server.
// Under TMPDIR when the socket path fits; else under MR_TEST_SOCKET_ROOT, which must be an absolute
// path to an existing directory outside the system temp roots; else a clear error, never a
// fallback. This file creates directories only under its own os.tmpdir(); /tmp is only read.
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { socketRootFor } from '../helpers/postgres.js';

/** `<dir>/mr-pg-XXXXXX/.s.PGSQL.5432` is this many bytes longer than `<dir>`. */
const SOCKET_SUFFIX_BYTES = Buffer.byteLength('/mr-pg-XXXXXX/.s.PGSQL.5432');
/** A TMPDIR whose socket path is far over the limit. A string only; nothing is created there. */
const LONG = `/${'long-tmpdir-'.padEnd(110, 'x')}`;

/** This file's directory under os.tmpdir(). */
let own = '';
/**
 * An existing directory outside the system temp roots: `own`, unless os.tmpdir() is itself in one
 * (Linux's default /tmp); then this file's source directory, which socketRootFor only reads.
 */
let outside = '';
before(async () => {
  own = await mkdtemp(path.join(os.tmpdir(), 'socket-root-'));
  const inSystemTemp = /^\/(private\/)?(var\/)?tmp(\/|$)/.test(await realpath(own));
  outside = inSystemTemp ? fileURLToPath(new URL('.', import.meta.url)) : own;
});
after(async () => {
  if (own) await rm(own, { recursive: true, force: true });
});

test('a socket path that fits stays under TMPDIR, up to 104 bytes with the NUL, whatever MR_TEST_SOCKET_ROOT says', async () => {
  const fits = `/${'d'.repeat(103 - SOCKET_SUFFIX_BYTES - 1)}`; // a 103-byte socket path
  assert.equal(await socketRootFor({ tmpdir: fits }), fits);
  assert.equal(await socketRootFor({ tmpdir: fits, socketRoot: 'not/absolute' }), fits);
  await assert.rejects(socketRootFor({ tmpdir: `${fits}d` }), /MR_TEST_SOCKET_ROOT/, 'a 104-byte socket path does not fit');
});

test('too long and MR_TEST_SOCKET_ROOT unset: the error says so and names the setting', async () => {
  for (const socketRoot of [undefined, '']) {
    await assert.rejects(socketRootFor({ tmpdir: LONG, socketRoot }), (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /socket path under TMPDIR \(.*\) is over the unix socket path limit of 104 bytes/);
      assert.match(err.message, /Set MR_TEST_SOCKET_ROOT to a short directory you own/);
      return true;
    });
  }
});

test('too long and MR_TEST_SOCKET_ROOT relative or missing: refused, even for an existing directory', async () => {
  const relative = path.relative(process.cwd(), own);
  assert.ok(!path.isAbsolute(relative));
  await assert.rejects(socketRootFor({ tmpdir: LONG, socketRoot: relative }), /MR_TEST_SOCKET_ROOT \(.*\) is not an absolute path/);
  await assert.rejects(socketRootFor({ tmpdir: LONG, socketRoot: path.join(outside, 'missing') }), /MR_TEST_SOCKET_ROOT \(.*\) does not exist/);
});

test('too long and MR_TEST_SOCKET_ROOT under /tmp, /private/tmp or /var/tmp, or resolving there: refused', async () => {
  for (const socketRoot of ['/tmp', '/private/tmp', '/var/tmp', '/tmp/']) {
    await assert.rejects(socketRootFor({ tmpdir: LONG, socketRoot }), /MR_TEST_SOCKET_ROOT \(.*\) is under \/(private\/)?(var\/)?tmp\b/, socketRoot);
  }
  // A link in this file's own directory to /tmp: outside the system temp roots only realpath shows
  // where it leads, so it is refused too.
  const link = path.join(own, 'to-tmp');
  await symlink('/tmp', link);
  await assert.rejects(socketRootFor({ tmpdir: LONG, socketRoot: link }), /MR_TEST_SOCKET_ROOT \(.*\) (resolves|is) under \/(private\/)?tmp\b/);
});

test('too long and a valid short MR_TEST_SOCKET_ROOT: that root is used, as its realpath', async () => {
  // The root's path may itself be long (os.tmpdir() can be), so the limit is set from it: a
  // socket directory just fits under the root and not under the longer TMPDIR.
  const real = await realpath(outside);
  const limit = Buffer.byteLength(real) + SOCKET_SUFFIX_BYTES + 1;
  const tmpdir = path.join(real, 'longer-tmpdir');
  assert.equal(await socketRootFor({ tmpdir, socketRoot: outside, limit }), real);
  await assert.rejects(socketRootFor({ tmpdir, socketRoot: outside, limit: limit - 1 }), /MR_TEST_SOCKET_ROOT \(.*\) is too long as well/);
});
