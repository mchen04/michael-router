// scripts/copy-keys-to-vercel.mjs against fake `vercel`, `security` and `op` executables placed
// first on PATH. Every source value is an invented sentinel; the tests prove the values arrive
// byte-exact on the fake's stdin and never anywhere else (argv, output, files, child env).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { parsePasswordHash, verifyPassword } from '../../src/auth.js';
import { loadConfig } from '../../src/config.js';
import { REPO, createFakeTools, makeScratchRoot } from '../helpers/fake-tools.js';
import { pathProblem, prohibitedRoots } from '../../scripts/copy-keys-to-vercel.mjs';

const SCRIPT = path.join(REPO, 'scripts', 'copy-keys-to-vercel.mjs');
const MARKER = 'SENTINEL';
const VALUES = Object.freeze({
  claude: 'sk-ant-fake-SENTINEL-copy-claude-7a1b',
  gemini: 'AIzaFAKE-SENTINEL-copy-gem-01',
  openrouter: 'sk-or-fake-SENTINEL-copy-openrouter-2c3d',
  other: 'sk-or-fake-SENTINEL-other-var-0000',
  password: 'pw-SENTINEL-copy-password-9e8f7d',
  unrelated: 'unrelated-SENTINEL-parent-env-5a5a',
});
const CHILD_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID', 'OP_ACCOUNT'];
const KEYCHAIN = { type: 'keychain', service: 'test-service', account: 'test-account' };
const OP_REF = 'op://Test Vault/Gemini/credential';
const FULL = [
  { env: 'ROUTER_SECRET', source: { type: 'generate', bytes: 32 }, onlyIfAbsent: true },
  { env: 'ROUTER_PASSWORD_HASH', source: { type: 'stdin' }, transform: 'scrypt-hash' },
  { env: 'ANTHROPIC_API_KEY', source: KEYCHAIN },
  { env: 'GEMINI_API_KEY', source: { type: 'op', ref: OP_REF } },
  { env: 'OPENROUTER_API_KEY', source: { type: 'file', path: '~/secrets/keys.env', var: 'OPENROUTER_API_KEY' } },
];
const sha = (/** @type {string} */ s) => createHash('sha256').update(s).digest('hex');

/** @type {Awaited<ReturnType<typeof makeScratchRoot>>} */
let scratch;
/** @type {Awaited<ReturnType<typeof createFakeTools>>} */
let fakes;
let home = '';
let tmpdir = '';
const skip = (() => {
  const problem = pathProblem(REPO, prohibitedRoots());
  return problem ? `the checkout itself is a prohibited source location (${problem})` : false;
})();

before(async () => {
  if (skip) return;
  scratch = await makeScratchRoot('copy-keys');
  fakes = await createFakeTools(scratch.root);
  home = path.join(scratch.root, 'home');
  tmpdir = path.join(scratch.root, 'tmpdir');
  await mkdir(path.join(home, 'secrets'), { recursive: true });
  await mkdir(tmpdir);
  const dotenv = [
    '# test keys',
    `export OTHER_KEY="${VALUES.other}"`,
    '',
    `OPENROUTER_API_KEY='${VALUES.openrouter}' # inline comment`,
  ].join('\n');
  await writeFile(path.join(home, 'secrets', 'keys.env'), dotenv);
});
after(async () => {
  await scratch?.remove();
});

/** The default fakes: every source available, nothing present in Vercel yet. @param {import('../helpers/fake-tools.js').FakeConfig} [extra] */
function configure(extra = {}) {
  return fakes.configure({
    keychain: { 'test-service/test-account': VALUES.claude },
    op: { [OP_REF]: VALUES.gemini },
    ...extra,
    vercel: { capture: ['ROUTER_PASSWORD_HASH', 'ROUTER_SECRET'], ...extra.vercel },
  });
}

/** @param {unknown[]} entries @param {Record<string, unknown>} [top] */
async function manifest(entries, top = {}) {
  const file = path.join(scratch.root, 'manifest.json');
  await writeFile(file, JSON.stringify({ version: 1, environment: 'production', entries, ...top }));
  return file;
}

/**
 * @param {string[]} args @param {{input?: string, env?: Record<string, string>}} [options]
 * @returns {Promise<{code: number | null, stdout: string, stderr: string}>}
 */
function runCopy(args, { input = '', env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: scratch.root,
      env: {
        PATH: [fakes.bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
        HOME: home,
        TMPDIR: tmpdir,
        UNRELATED_TOKEN: VALUES.unrelated,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('copy-keys-to-vercel timed out'));
    }, 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** @param {import('../helpers/fake-tools.js').FakeCall[]} calls */
const adds = (calls) => calls.filter((c) => c.tool === 'vercel' && c.argv[1] === 'add' && c.argv[2] !== '--help').map((c) => c.argv[2]);

/** Every file under the test root except the fake's source data and the dotenv source. @param {string} dir */
async function scannedFiles(dir = scratch.root) {
  /** @type {string[]} */
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (p === fakes.state || p === path.join(home, 'secrets')) continue;
    if (e.isDirectory()) out.push(...(await scannedFiles(p)));
    else out.push(p);
  }
  return out;
}

/** @param {string[]} secrets @param {{stdout: string, stderr: string}} run */
async function assertNoSecretLeaked(secrets, run) {
  const calls = JSON.stringify(await fakes.calls());
  for (const s of [...secrets, MARKER]) {
    assert.ok(!run.stdout.includes(s) && !run.stderr.includes(s), 'a secret reached stdout or stderr');
    assert.ok(!calls.includes(s), 'a secret reached a child argv or environment name');
  }
  for (const file of await scannedFiles()) {
    const text = await readFile(file, 'latin1');
    for (const s of [...secrets, MARKER]) assert.ok(!text.includes(s), `a secret reached ${path.relative(scratch.root, file)}`);
  }
}

test('without --yes it prints the plan and a digest of names and sources, and reads nothing', { skip }, async () => {
  await configure();
  const r = await runCopy(['--manifest', await manifest(FULL)]);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.match(lines[1], /^ {2}1\. ROUTER_SECRET +<- generate:32 \(only if absent\)$/);
  assert.match(lines[2], /^ {2}2\. ROUTER_PASSWORD_HASH <- stdin \(scrypt-hash\)$/);
  assert.match(lines[3], /^ {2}3\. ANTHROPIC_API_KEY +<- keychain:test-service\/test-account$/);
  assert.match(r.stdout, /Dry run: nothing was read or transferred/);
  assert.deepEqual(await fakes.calls(), [], 'no child process ran');
  const digest = /Plan digest: sha256:([0-9a-f]{64})/.exec(r.stdout)?.[1];
  assert.ok(digest);

  // Canonical: key order and whitespace do not matter; a different source does.
  const reordered = FULL.map((e) => Object.fromEntries(Object.entries(e).reverse()));
  const file = path.join(scratch.root, 'reordered.json');
  await writeFile(file, JSON.stringify({ entries: reordered, environment: 'production', version: 1 }, null, 2));
  assert.match((await runCopy(['--manifest', file])).stdout, new RegExp(`sha256:${digest}`));
  const changed = FULL.map((e) => (e.env === 'ANTHROPIC_API_KEY' ? { ...e, source: { ...KEYCHAIN, account: 'other' } } : e));
  assert.doesNotMatch((await runCopy(['--manifest', await manifest(changed)])).stdout, new RegExp(`sha256:${digest}`));

  // The shipped example manifest is valid as written.
  const example = await runCopy(['--manifest', path.join(REPO, 'scripts', 'key-sources.example.json')]);
  assert.equal(example.code, 0, example.stderr);
  assert.match(example.stdout, /^Plan: 5 entries for Vercel environment "production"/);
});

test('--yes transfers every source type byte-exact on stdin and nothing leaks anywhere', { skip }, async () => {
  await configure();
  const r = await runCopy(['--manifest', await manifest(FULL), '--yes'], { input: `${VALUES.password}\n` });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  for (const [i, e] of FULL.entries()) assert.match(r.stdout, new RegExp(`^\\[${i + 1}/5\\] ${e.env}: set \\(sensitive\\)$`, 'm'));
  assert.match(r.stdout, /^Present in Vercel production \(names only\): ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, ROUTER_PASSWORD_HASH, ROUTER_SECRET$/m);
  assert.match(r.stdout, /^Store: no complete store pair/m);
  assert.doesNotMatch(r.stdout, /RAW-LS-OUTPUT/, 'raw vercel env ls output is never printed');

  const calls = await fakes.calls();
  const vercel = calls.filter((c) => c.tool === 'vercel').map((c) => c.argv.join(' '));
  assert.deepEqual(vercel, [
    'env add --help',
    'env ls production',
    ...FULL.map((e) => `env add ${e.env} production ${e.onlyIfAbsent ? '' : '--force '}--sensitive`),
    'env ls production',
  ]);
  assert.deepEqual(calls.find((c) => c.tool === 'security')?.argv, ['find-generic-password', '-s', 'test-service', '-a', 'test-account', '-w']);
  assert.deepEqual(calls.find((c) => c.tool === 'op')?.argv, ['read', OP_REF]);
  for (const c of calls) {
    const extra = c.env.filter((n) => !CHILD_ENV.includes(n) && !n.startsWith('__CF'));
    assert.deepEqual(extra, [], `${c.tool} received non-allowlisted environment variables`);
  }

  const captured = await fakes.captured();
  const uploaded = Object.fromEntries(calls.filter((c) => c.argv[1] === 'add' && c.argv[2] !== '--help').map((c) => [c.argv[2], c.stdin_sha256]));
  assert.equal(uploaded.ANTHROPIC_API_KEY, sha(VALUES.claude));
  assert.equal(uploaded.GEMINI_API_KEY, sha(VALUES.gemini));
  assert.equal(uploaded.OPENROUTER_API_KEY, sha(VALUES.openrouter), 'the dotenv value, quotes and comment stripped');
  assert.equal(uploaded.ROUTER_PASSWORD_HASH, sha(captured.ROUTER_PASSWORD_HASH));
  assert.equal(uploaded.ROUTER_SECRET, sha(captured.ROUTER_SECRET));

  // The uploaded hash is one the server verifies, and the generated secret is one it accepts.
  const parsed = parsePasswordHash(captured.ROUTER_PASSWORD_HASH);
  assert.ok(parsed);
  assert.equal(await verifyPassword(parsed, VALUES.password), true);
  assert.equal(await verifyPassword(parsed, `${VALUES.password}x`), false);
  const config = loadConfig({ ROUTER_PASSWORD_HASH: captured.ROUTER_PASSWORD_HASH, ROUTER_SECRET: captured.ROUTER_SECRET, ROUTER_STORE: 'memory' });
  assert.deepEqual(config.problems, []);

  await assertNoSecretLeaked([...Object.values(VALUES), captured.ROUTER_PASSWORD_HASH, captured.ROUTER_SECRET], r);
});

test('onlyIfAbsent skips a present name; --check reads every source but adds nothing', { skip }, async () => {
  await configure({ vercel: { present: ['ROUTER_SECRET'] } });
  const file = await manifest(FULL);
  const check = await runCopy(['--manifest', file, '--check'], { input: VALUES.password });
  assert.equal(check.code, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /^\[1\/5\] ROUTER_SECRET: would skip \(already present in production\)$/m);
  for (const e of FULL.slice(1)) assert.match(check.stdout, new RegExp(`^\\[\\d/5\\] ${e.env}: ok$`, 'm'));
  assert.match(check.stdout, /Check passed: 5 entries; nothing was transferred/);
  const checkCalls = await fakes.calls();
  assert.deepEqual(checkCalls.filter((c) => c.tool === 'vercel').map((c) => c.argv.join(' ')), ['env ls production']);
  assert.deepEqual(checkCalls.map((c) => c.tool).sort(), ['op', 'security', 'vercel'], 'every source was read once');

  const yes = await runCopy(['--manifest', file, '--yes'], { input: VALUES.password });
  assert.equal(yes.code, 0, yes.stdout + yes.stderr);
  assert.match(yes.stdout, /^\[1\/5\] ROUTER_SECRET: skipped \(already present in production\)$/m);
  assert.deepEqual(adds(await fakes.calls()), ['ROUTER_PASSWORD_HASH', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']);
  await assertNoSecretLeaked(Object.values(VALUES), yes);
});

test('an onlyIfAbsent entry is never overwritten, even when env ls does not list it', { skip }, async () => {
  await configure({ vercel: { hidden: ['ROUTER_SECRET'] } });
  const r = await runCopy(['--manifest', await manifest([FULL[0], FULL[2]]), '--yes']);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^\[1\/2\] ROUTER_SECRET: skipped \(already exists in production\)$/m);
  const vercel = (await fakes.calls()).filter((c) => c.tool === 'vercel').map((c) => c.argv.join(' '));
  assert.ok(vercel.includes('env add ROUTER_SECRET production --sensitive'), vercel.join('; '));
  assert.ok(!vercel.some((c) => c.startsWith('env add ROUTER_SECRET ') && c.includes('--force')), 'onlyIfAbsent never uses --force');
  assert.equal((await fakes.captured()).ROUTER_SECRET, undefined, 'the existing ROUTER_SECRET was replaced');
  assert.match(r.stdout, /^Present in Vercel production \(names only\): ANTHROPIC_API_KEY, ROUTER_SECRET$/m);
});

test('the first failure stops the run with exit 3 and a scrubbed reason; no later entry is touched', { skip }, async () => {
  const order = [FULL[1], FULL[2], FULL[3], FULL[4]]; // stdin, keychain, op, file
  const file = await manifest(order);

  // A guard refusal from the keychain.
  await configure({ keychain: { 'test-service/test-account': { exit: 51, stderr: 'security: SecKeychainSearchCopyNext: User interaction is not allowed.' } } });
  let r = await runCopy(['--manifest', file, '--yes'], { input: VALUES.password });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /^STOPPED at ANTHROPIC_API_KEY \(source keychain:test-service\/test-account\): security: SecKeychainSearchCopyNext: User interaction is not allowed\.$/m);
  let calls = await fakes.calls();
  assert.deepEqual(adds(calls), ['ROUTER_PASSWORD_HASH']);
  assert.equal(calls.filter((c) => c.tool === 'op').length, 0, 'no later source is read');

  // Vercel refuses and echoes the value: the stop line is scrubbed.
  await configure({ vercel: { refuse: { ANTHROPIC_API_KEY: 'refused by policy for {value}' } } });
  r = await runCopy(['--manifest', file, '--yes'], { input: VALUES.password });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /^STOPPED at ANTHROPIC_API_KEY \(source keychain:test-service\/test-account\): Error: refused by policy for \[redacted\]$/m);
  calls = await fakes.calls();
  assert.deepEqual(adds(calls), ['ROUTER_PASSWORD_HASH', 'ANTHROPIC_API_KEY']);
  assert.equal(calls.filter((c) => c.tool === 'op').length, 0);
  await assertNoSecretLeaked(Object.values(VALUES), r);

  // A value with whitespace fails validation before any upload.
  await configure({ op: { [OP_REF]: 'AIzaFAKE SENTINEL with-space' } });
  r = await runCopy(['--manifest', file, '--yes'], { input: VALUES.password });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /^STOPPED at GEMINI_API_KEY \(source op:op:\/\/Test Vault\/Gemini\/credential\): the value contains whitespace, control or non-ASCII characters$/m);
  assert.deepEqual(adds(await fakes.calls()), ['ROUTER_PASSWORD_HASH', 'ANTHROPIC_API_KEY']);
  assert.doesNotMatch(r.stdout, /OPENROUTER_API_KEY: /);

  // A Vercel CLI that cannot mark values sensitive: stop before any source is read.
  await configure({ vercel: { sensitive: false } });
  r = await runCopy(['--manifest', file, '--yes'], { input: VALUES.password });
  assert.equal(r.code, 3, r.stdout);
  assert.match(r.stdout, /^STOPPED at vercel env add --help: this Vercel CLI does not offer --sensitive; /m);
  assert.deepEqual((await fakes.calls()).map((c) => `${c.tool} ${c.argv.join(' ')}`), ['vercel env add --help']);
});

test('file sources under prohibited roots, shell rc files and relative paths are refused', { skip }, async () => {
  await configure();
  const cases = [
    ['~/.hermes/.env', path.join(home, '.hermes')],
    ['~/.claude/keys.env', path.join(home, '.claude')],
    ['~/.codex/keys.env', path.join(home, '.codex')],
    ['~/.cache/keys.env', path.join(home, '.cache')],
    ['/tmp/keys.env', '/tmp'],
    ['/private/keys.env', '/private'],
    ['/var/folders/keys.env', '/var/folders'],
    ['/etc/keys.env', '/etc'],
    [path.join(tmpdir, 'keys.env'), tmpdir],
    ['~/.zshrc', 'shell rc files are never read'],
    [path.join(home, 'secrets', '.bash_profile'), 'shell rc files are never read'],
    ['secrets/keys.env', 'must be absolute'],
  ];
  // The account's home from the user database is protected as well as $HOME.
  const passwdHome = os.userInfo().homedir;
  if (path.resolve(passwdHome) !== path.resolve(home)) cases.push([path.join(passwdHome, '.hermes', 'copy-keys-test.env'), path.join(passwdHome, '.hermes')]);
  for (const [p, reason] of cases) {
    const r = await runCopy(['--manifest', await manifest([{ env: 'OPENROUTER_API_KEY', source: { type: 'file', path: p, var: 'OPENROUTER_API_KEY' } }])]);
    assert.equal(r.code, 2, `${p} was not refused`);
    assert.ok(r.stderr.includes(reason), `${p}: ${r.stderr}`);
  }

  // A symlink from an allowed directory into a temp dir is refused after realpath.
  const outside = await mkdtemp(path.join(os.tmpdir(), 'copy-keys-outside-'));
  try {
    await writeFile(path.join(outside, 'real.env'), `OPENROUTER_API_KEY=${VALUES.openrouter}\n`);
    await symlink(path.join(outside, 'real.env'), path.join(home, 'link.env'));
    const r = await runCopy(['--manifest', await manifest([{ env: 'OPENROUTER_API_KEY', source: { type: 'file', path: '~/link.env', var: 'OPENROUTER_API_KEY' } }]), '--check']);
    assert.equal(r.code, 3);
    assert.match(r.stdout, /^STOPPED at OPENROUTER_API_KEY \(source file:~\/link\.env#OPENROUTER_API_KEY\): the file resolves to a refused location: the path is under the prohibited root /m);

    // macOS: the same directory through the /System/Volumes/Data firmlink, which realpath keeps.
    const firm = path.join('/System/Volumes/Data', await realpath(outside), 'real.env');
    if (process.platform === 'darwin' && existsSync(firm)) {
      const f = await runCopy(['--manifest', await manifest([{ env: 'OPENROUTER_API_KEY', source: { type: 'file', path: firm, var: 'OPENROUTER_API_KEY' } }]), '--check']);
      assert.equal(f.code, 3, f.stdout);
      assert.match(f.stdout, /: the file resolves to a refused location: the path is under the prohibited root \//m);
    }
  } finally {
    await rm(outside, { recursive: true, force: true });
    await rm(path.join(home, 'link.env'), { force: true });
  }

  // A second hard link to a file under a prohibited root (here $HOME/.cache).
  await mkdir(path.join(home, '.cache'));
  try {
    await writeFile(path.join(home, '.cache', 'keys.env'), `OPENROUTER_API_KEY=${VALUES.openrouter}\n`);
    await link(path.join(home, '.cache', 'keys.env'), path.join(home, 'hard.env'));
    const r = await runCopy(['--manifest', await manifest([{ env: 'OPENROUTER_API_KEY', source: { type: 'file', path: '~/hard.env', var: 'OPENROUTER_API_KEY' } }]), '--check']);
    assert.equal(r.code, 3, r.stdout);
    assert.match(r.stdout, /^STOPPED at OPENROUTER_API_KEY \(source file:~\/hard\.env#OPENROUTER_API_KEY\): the file has more than one hard link/m);
  } finally {
    await rm(path.join(home, '.cache'), { recursive: true, force: true });
    await rm(path.join(home, 'hard.env'), { force: true });
  }
  assert.deepEqual(adds(await fakes.calls()), []);
});

test('malformed manifests are refused before anything runs', { skip }, async () => {
  await configure();
  const stdin = { env: 'ROUTER_PASSWORD_HASH', source: { type: 'stdin' }, transform: 'scrypt-hash' };
  /** @type {[string, unknown[], Record<string, unknown>?][]} */
  const cases = [
    ['unknown key "note"', [{ ...stdin, note: 'x' }]],
    ['"env" must be one of', [{ env: 'OPENAI_API_KEY', source: { type: 'stdin' } }]],
    ['appears more than once', [{ env: 'ANTHROPIC_API_KEY', source: KEYCHAIN }, { env: 'ANTHROPIC_API_KEY', source: { type: 'op', ref: OP_REF } }]],
    ['at most one entry may read stdin', [stdin, { env: 'ANTHROPIC_API_KEY', source: { type: 'stdin' } }]],
    ['"generate" is for ROUTER_SECRET', [{ env: 'ROUTER_SECRET', source: { type: 'generate', bytes: 32 } }]],
    ['not both', [stdin, { env: 'ROUTER_PASSWORD', source: KEYCHAIN }]],
    ['"environment" must be "production"', [stdin], { environment: 'preview' }],
  ];
  for (const [message, entries, top] of cases) {
    const r = await runCopy(['--manifest', await manifest(entries, top), '--yes'], { input: VALUES.password });
    assert.equal(r.code, 2, message);
    assert.ok(r.stderr.includes(message), `${message}: ${r.stderr}`);
  }

  // Key-shaped text in a descriptor or a key name is refused without being echoed.
  const shaped = 'sk-ant-fake-SENTINEL-descriptor-0001';
  /** @type {unknown[]} */
  const echoes = [
    { env: 'ANTHROPIC_API_KEY', source: { ...KEYCHAIN, account: shaped } },
    { env: 'GEMINI_API_KEY', source: { type: 'op', ref: `op://Vault/${shaped}/credential` } },
    { env: 'OPENROUTER_API_KEY', source: { type: 'file', path: `~/${shaped}.env`, var: 'OPENROUTER_API_KEY' } },
    { ...stdin, AIzaFAKESENTINELkeyShapedName0: 'x' },
  ];
  for (const entry of echoes) {
    const r = await runCopy(['--manifest', await manifest([entry])]);
    assert.equal(r.code, 2, r.stdout);
    assert.match(r.stderr, /looks like a secret|unknown key$/m);
    assert.ok(!(r.stdout + r.stderr).includes(MARKER), 'a key-shaped descriptor was echoed');
  }
  assert.deepEqual(await fakes.calls(), []);
});

test('password-variable conflicts and names missing after the transfer fail with exit 3', { skip }, async () => {
  const file = await manifest([FULL[1], FULL[2]]);
  await configure({ vercel: { present: ['ROUTER_PASSWORD'] } });
  let r = await runCopy(['--manifest', file, '--yes'], { input: VALUES.password });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /^STOPPED at pre-check: the manifest sets ROUTER_PASSWORD_HASH but ROUTER_PASSWORD already exists in production; .*vercel env rm ROUTER_PASSWORD production/m);
  let calls = await fakes.calls();
  assert.deepEqual(adds(calls), []);
  assert.equal(calls.filter((c) => c.tool === 'security').length, 0, 'no source was read');

  await configure({ vercel: { dropAdds: true } });
  r = await runCopy(['--manifest', file, '--yes'], { input: VALUES.password });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /^STOPPED at final check: not present after the transfer: ROUTER_PASSWORD_HASH, ANTHROPIC_API_KEY$/m);
  calls = await fakes.calls();
  assert.deepEqual(adds(calls), ['ROUTER_PASSWORD_HASH', 'ANTHROPIC_API_KEY']);
});
