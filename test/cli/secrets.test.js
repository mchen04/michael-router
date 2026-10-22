// Secret input through the real binary: hash-password from stdin, and the hidden prompt on a real
// pseudo-terminal (no echo, editing, Ctrl-C) plus terminal-only colors.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { parsePasswordHash, verifyPassword } from '../../src/auth.js';
import { MIN_PASSWORD_LENGTH } from '../../src/config.js';
import { PTY_SKIP, configDir, finishCliSuite, makeHome, plain, runCli, runCliPty } from '../helpers/cli.js';
import { PASSWORD, baseEnv } from '../helpers/fixtures.js';
import { startDevServer } from '../helpers/processes.js';

/** @type {Awaited<ReturnType<typeof startDevServer>>} */
let router;
before(async () => {
  router = await startDevServer(await baseEnv());
});
after(async () => {
  await router?.stop();
  await finishCliSuite();
});

const NEW_PASSWORD = 'pw-SENTINEL-new-router-password-42';

/** @param {string} hash @param {string} password */
async function assertHashOf(hash, password) {
  const parsed = parsePasswordHash(hash);
  assert.ok(parsed, 'a valid ROUTER_PASSWORD_HASH');
  assert.equal(await verifyPassword(parsed, password), true);
}

test('hash-password reads stdin and prints a hash that verifies; --json; bad input exits 2', async () => {
  const home = await makeHome();
  const r = await runCli(['hash-password'], { home, input: `${NEW_PASSWORD}\n` });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^scrypt\$15\$8\$1\$[\w-]+\$[\w-]+$/, 'no trailing newline when stdout is not a terminal');
  await assertHashOf(r.stdout, NEW_PASSWORD);
  const json = JSON.parse((await runCli(['hash-password', '--json'], { home, input: NEW_PASSWORD })).stdout);
  await assertHashOf(json.ROUTER_PASSWORD_HASH, NEW_PASSWORD);

  const cases = [
    [['hash-password', NEW_PASSWORD], '', 'mrouter: passwords are never accepted as arguments; pipe them on stdin or use the prompt\n'],
    [['hash-password'], 'pw-SENTINEL\n', `mrouter: the password must be at least ${MIN_PASSWORD_LENGTH} characters long\n`],
    [['hash-password'], ` ${NEW_PASSWORD}`, 'mrouter: the password must be printable ASCII without leading or trailing spaces\n'],
  ];
  for (const [args, input, stderr] of /** @type {[string[], string, string][]} */ (cases)) {
    const e = await runCli(args, { home, input });
    assert.deepEqual([e.code, e.stdout, e.stderr], [2, '', stderr]);
  }
});

test('login on a terminal: the hidden prompt never echoes, handles backspace, and stores the password', { skip: PTY_SKIP }, async () => {
  const home = await makeHome();
  const r = await runCliPty(['login', '--url', router.url], {
    home,
    steps: [{ waitFor: /Router password: $/, send: `${PASSWORD}#\u007f\r` }],
  });
  assert.equal(r.code, 0, r.output);
  const out = plain(r.output);
  assert.match(out, /^Router password: \nLogged in to http:\/\/127\.0\.0\.1:\d+\.\n/);
  assert.ok(!out.includes('#'), 'typed characters are not echoed');
  assert.equal(await readFile(path.join(configDir(home), 'credentials'), 'utf8'), PASSWORD);
});

test('hash-password on a terminal asks twice; Ctrl-C at the prompt exits 130', { skip: PTY_SKIP }, async () => {
  const home = await makeHome();
  const r = await runCliPty(['hash-password'], {
    home,
    steps: [
      { waitFor: /New router password: $/, send: `${NEW_PASSWORD}\r` },
      { waitFor: /Repeat to confirm: $/, send: `${NEW_PASSWORD}\r` },
    ],
  });
  assert.equal(r.code, 0, r.output);
  const hash = /** @type {RegExpExecArray} */ (/^(scrypt\$\S+)\n/m.exec(plain(r.output)))[1];
  await assertHashOf(hash, NEW_PASSWORD);

  const cancelled = await runCliPty(['login', '--url', router.url], { home, steps: [{ waitFor: /Router password: $/, send: 'pw-SENTINEL-abc\u0003' }] });
  assert.equal(cancelled.code, 130);
  assert.match(plain(cancelled.output), /^Router password: \nmrouter: cancelled\n/);
});

test('colors only on a terminal, and never with --no-color or NO_COLOR, argument errors included', { skip: PTY_SKIP }, async () => {
  const home = await makeHome();
  assert.match((await runCliPty(['status'], { home })).output, /\x1b\[1mURL/);
  assert.doesNotMatch((await runCliPty(['status', '--no-color'], { home })).output, /\x1b\[/);
  assert.doesNotMatch((await runCliPty(['status'], { home, env: { NO_COLOR: '1' } })).output, /\x1b\[/);
  const colored = await runCliPty(['nope'], { home });
  assert.equal(colored.code, 2);
  assert.match(colored.output, /\x1b\[31mmrouter:/);
  const uncolored = await runCliPty(['--no-color', 'nope'], { home });
  assert.equal(uncolored.code, 2);
  assert.equal(plain(uncolored.output).split('\n')[0], `mrouter: unknown command "nope" (see 'mrouter --help')`);
  assert.doesNotMatch(uncolored.output, /\x1b\[/);
});
