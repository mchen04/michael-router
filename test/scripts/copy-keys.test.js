// scripts/copy-keys-to-vercel.mjs against fake `vercel`, `security` and `op` executables placed
// first on PATH. Every source value is an invented sentinel; the tests prove the values arrive
// byte-exact on the fake's stdin and never anywhere else (argv, output, files, child env).
// The script runs as a copy inside a scratch repository (with scripts/lib/, src/ and
// package.json), so the tests control <repo>/.vercel/project.json and never touch the checkout's
// own link.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, cp, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { parsePasswordHash, verifyPassword } from '../../src/auth.js';
import { loadConfig } from '../../src/config.js';
import { REPO, createFakeTools, makeScratchRoot } from '../helpers/fake-tools.js';
import { pathProblem, prohibitedRoots, validateManifest } from '../../scripts/copy-keys-to-vercel.mjs';

const MARKER = 'SENTINEL';
const VALUES = Object.freeze({
  claude: 'sk-ant-fake-SENTINEL-copy-claude-7a1b',
  gemini: 'AIzaFAKE-SENTINEL-copy-gem-01',
  openrouter: 'sk-or-fake-SENTINEL-copy-openrouter-2c3d',
  other: 'sk-or-fake-SENTINEL-other-var-0000',
  password: 'pw-SENTINEL-copy-password-9e8f7d',
  unrelated: 'unrelated-SENTINEL-parent-env-5a5a',
});
const CHILD_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'OP_ACCOUNT'];
/** The pinned project (fake-shaped ids), and other projects the keys must never go to. */
const PROJECT = Object.freeze({ orgId: 'team_TestOrg01', projectId: 'prj_TestProject01' });
const PINNED = `${PROJECT.orgId}/${PROJECT.projectId}`;
const INHERITED = Object.freeze({ VERCEL_ORG_ID: 'team_InheritedOrg', VERCEL_PROJECT_ID: 'prj_InheritedProject' });
const OTHER_LINK = Object.freeze({ orgId: 'team_LinkedOrg', projectId: 'prj_LinkedProject', projectName: 'linked' });
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
/** The scratch repository root and the script copy inside it. */
let repo = '';
let script = '';
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
  repo = path.join(scratch.root, 'repo');
  script = path.join(repo, 'scripts', 'copy-keys-to-vercel.mjs');
  await mkdir(path.dirname(script), { recursive: true });
  await copyFile(path.join(REPO, 'scripts', 'copy-keys-to-vercel.mjs'), script);
  await cp(path.join(REPO, 'scripts', 'lib'), path.join(repo, 'scripts', 'lib'), { recursive: true });
  await copyFile(path.join(REPO, 'package.json'), path.join(repo, 'package.json'));
  await cp(path.join(REPO, 'src'), path.join(repo, 'src'), { recursive: true });
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

/** @param {unknown[]} entries @param {Record<string, unknown>} [top] (`project: undefined` omits it) */
async function manifest(entries, top = {}) {
  const file = path.join(scratch.root, 'manifest.json');
  await writeFile(file, JSON.stringify({ version: 1, environment: 'production', project: PROJECT, entries, ...top }));
  return file;
}

/** Write <dir>/.vercel/project.json (an object as JSON, a string as is). @param {string} dir @param {unknown} content */
async function writeLink(dir, content) {
  await mkdir(path.join(dir, '.vercel'), { recursive: true });
  await writeFile(path.join(dir, '.vercel', 'project.json'), typeof content === 'string' ? content : JSON.stringify(content));
}

/**
 * @param {string[]} args @param {{input?: string, env?: Record<string, string>, cwd?: string}} [options]
 * @returns {Promise<{code: number | null, stdout: string, stderr: string}>}
 */
function runCopy(args, { input = '', env = {}, cwd = scratch.root } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
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

test('without --yes it prints the project, the plan and a digest of all three, and reads nothing', { skip }, async () => {
  await configure();
  const r = await runCopy(['--manifest', await manifest(FULL)]);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.equal(lines[0], 'Vercel project: prj_TestProject01 (org team_TestOrg01)');
  assert.equal(lines[1], 'Plan: 5 entries for Vercel environment "production", in this order:');
  assert.match(lines[2], /^ {2}1\. ROUTER_SECRET +<- generate:32 \(only if absent\)$/);
  assert.match(lines[3], /^ {2}2\. ROUTER_PASSWORD_HASH <- stdin \(scrypt-hash\)$/);
  assert.match(lines[4], /^ {2}3\. ANTHROPIC_API_KEY +<- keychain:test-service\/test-account$/);
  assert.match(r.stdout, /Dry run: nothing was read or transferred/);
  assert.deepEqual(await fakes.calls(), [], 'no child process ran');
  const digest = /Plan digest: sha256:([0-9a-f]{64})/.exec(r.stdout)?.[1];
  assert.ok(digest);

  // Canonical: key order and whitespace do not matter; a different source or project does.
  const reversed = (/** @type {object} */ o) => Object.fromEntries(Object.entries(o).reverse());
  const reordered = FULL.map(reversed);
  const file = path.join(scratch.root, 'reordered.json');
  await writeFile(file, JSON.stringify({ entries: reordered, project: reversed(PROJECT), environment: 'production', version: 1 }, null, 2));
  assert.match((await runCopy(['--manifest', file])).stdout, new RegExp(`sha256:${digest}`));
  const changed = FULL.map((e) => (e.env === 'ANTHROPIC_API_KEY' ? { ...e, source: { ...KEYCHAIN, account: 'other' } } : e));
  assert.doesNotMatch((await runCopy(['--manifest', await manifest(changed)])).stdout, new RegExp(`sha256:${digest}`));
  for (const project of [{ ...PROJECT, projectId: 'prj_TestProject02' }, { ...PROJECT, orgId: 'team_TestOrg02' }]) {
    const other = await runCopy(['--manifest', await manifest(FULL, { project })]);
    assert.equal(other.code, 0, other.stderr);
    assert.equal(other.stdout.split('\n')[0], `Vercel project: ${project.projectId} (org ${project.orgId})`);
    assert.doesNotMatch(other.stdout, new RegExp(`sha256:${digest}`), 'the digest covers the project');
  }

  // The shipped example manifests are valid as written.
  const example = await runCopy(['--manifest', path.join(REPO, 'scripts', 'key-sources.example.json')]);
  assert.equal(example.code, 0, example.stderr);
  assert.match(example.stdout, /^Vercel project: prj_example \(org team_example\)\nPlan: 5 entries for Vercel environment "production"/);
  const database = await runCopy(['--manifest', path.join(REPO, 'scripts', 'database-sources.example.json')]);
  assert.equal(database.code, 0, database.stderr);
  assert.match(database.stdout, /^Vercel project: prj_example \(org team_example\)\nPlan: 1 entry for Vercel environment "production", in this order:\n {2}1\. DATABASE_URL_POOLED <- stdin-env:DATABASE_URL_POOLED\n/);
});

test('--yes transfers every source type byte-exact on stdin and nothing leaks anywhere', { skip }, async () => {
  await configure();
  const r = await runCopy(['--manifest', await manifest(FULL), '--yes'], { input: `${VALUES.password}\n` });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  for (const [i, e] of FULL.entries()) assert.match(r.stdout, new RegExp(`^\\[${i + 1}/5\\] ${e.env}: set \\(sensitive\\)$`, 'm'));
  assert.match(r.stdout, /^Present in Vercel production \(names only\): ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, ROUTER_PASSWORD_HASH, ROUTER_SECRET$/m);
  assert.match(r.stdout, /^Store: neither DATABASE_URL_POOLED nor DATABASE_URL is present; protected routes answer 503/m);
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
  // Every vercel child is pinned to the manifest's project and runs from the repository root;
  // security and op get no Vercel ids at all.
  const root = await realpath(repo);
  for (const c of calls) {
    const allowed = c.tool === 'vercel' ? [...CHILD_ENV, 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID'] : CHILD_ENV;
    const extra = c.env.filter((n) => !allowed.includes(n) && !n.startsWith('__CF'));
    assert.deepEqual(extra, [], `${c.tool} received non-allowlisted environment variables`);
    if (c.tool !== 'vercel') continue;
    assert.deepEqual(c.ids, PROJECT, `vercel ${c.argv.join(' ')}`);
    assert.equal(c.target, PINNED);
    assert.equal(await realpath(c.cwd), root, 'vercel runs from the repository root');
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

/** stdin-env entries for the two database URLs, both read from one dotenv document on stdin. */
const DATABASE = [
  { env: 'DATABASE_URL_POOLED', source: { type: 'stdin-env', var: 'DATABASE_URL_POOLED' } },
  { env: 'DATABASE_URL', source: { type: 'stdin-env', var: 'DATABASE_URL' } },
];
const POOLED = 'postgresql://router:db-pw-SENTINEL-pooled-copy@db-pooler.example.test/router?sslmode=require&channel_binding=require';
const DIRECT = 'postgresql://router:db-pw-SENTINEL-direct-copy@db.example.test/router?sslmode=verify-full';
/** @param {string} pooled @param {string} direct */
const databaseDocument = (pooled, direct) => `# database\nexport DATABASE_URL_POOLED="${pooled}"\nDATABASE_URL='${direct}' # direct endpoint\nOTHER_SETTING=unrelated\n`;

test('stdin-env: plan, --check and --yes read one dotenv document once; each URL reaches only its vercel env add stdin', { skip }, async () => {
  await configure();
  const file = await manifest(DATABASE);
  const plan = await runCopy(['--manifest', file]);
  assert.equal(plan.code, 0, plan.stderr);
  assert.match(plan.stdout, /^ {2}1\. DATABASE_URL_POOLED <- stdin-env:DATABASE_URL_POOLED\n {2}2\. DATABASE_URL {8}<- stdin-env:DATABASE_URL\n/m);
  const digest = /Plan digest: sha256:([0-9a-f]{64})/.exec(plan.stdout)?.[1];
  assert.ok(digest);
  const renamed = await runCopy(['--manifest', await manifest([{ ...DATABASE[0], source: { type: 'stdin-env', var: 'NEON_POOLED_URL' } }, DATABASE[1]])]);
  assert.doesNotMatch(renamed.stdout, new RegExp(digest), 'the digest covers the stdin-env variable');
  await manifest(DATABASE); // manifest() rewrites one file
  assert.deepEqual(await fakes.calls(), [], 'the plan runs nothing');

  const input = databaseDocument(POOLED, DIRECT);
  const check = await runCopy(['--manifest', file, '--check'], { input });
  assert.equal(check.code, 0, check.stdout + check.stderr);
  assert.match(check.stdout, new RegExp(`sha256:${digest}`), 'the same digest in every mode');
  assert.match(check.stdout, /^\[1\/2\] DATABASE_URL_POOLED: ok\n\[2\/2\] DATABASE_URL: ok\nCheck passed: 2 entries; nothing was transferred\.$/m);
  assert.deepEqual((await fakes.calls()).map((c) => `${c.tool} ${c.argv.join(' ')}`), ['vercel env ls production']);

  await configure();
  const yes = await runCopy(['--manifest', file, '--yes'], { input });
  assert.equal(yes.code, 0, yes.stdout + yes.stderr);
  assert.match(yes.stdout, new RegExp(`sha256:${digest}`));
  assert.match(yes.stdout, /^\[1\/2\] DATABASE_URL_POOLED: set \(sensitive\)\n\[2\/2\] DATABASE_URL: set \(sensitive\)$/m);
  assert.match(yes.stdout, /^Store: DATABASE_URL_POOLED is present; the router uses it\.$/m);
  const calls = await fakes.calls();
  assert.deepEqual(calls.filter((c) => c.tool === 'vercel').map((c) => c.argv.join(' ')), [
    'env add --help',
    'env ls production',
    'env add DATABASE_URL_POOLED production --force --sensitive',
    'env add DATABASE_URL production --force --sensitive',
    'env ls production',
  ]);
  const uploaded = Object.fromEntries(calls.filter((c) => c.argv[1] === 'add' && c.argv[2] !== '--help').map((c) => [c.argv[2], c.stdin_sha256]));
  assert.deepEqual(uploaded, { DATABASE_URL_POOLED: sha(POOLED), DATABASE_URL: sha(DIRECT) }, 'quotes and comment stripped, byte-exact');
  for (const r of [check, yes]) await assertNoSecretLeaked([POOLED, DIRECT, 'db-pw-SENTINEL-pooled-copy', 'db-pw-SENTINEL-direct-copy'], r);
});

test('database URLs are checked before any upload: shape, TLS, the router rules and the Neon pooled/direct endpoints', { skip }, async () => {
  await configure();
  const neon = (/** @type {string} */ endpoint) => `postgresql://router:pw@${endpoint}.us-east-2.aws.neon.tech/db_SENTINEL?sslmode=require&channel_binding=require`;
  const local = (/** @type {string} */ rest) => `postgresql://router:pw@db.example.test/db_SENTINEL${rest}`;
  /** @type {[string, string, string][]} */
  const refused = [
    ['DATABASE_URL_POOLED', 'https://router:pw@db.example.test/db_SENTINEL?sslmode=require', 'the database URL must start with postgres:// or postgresql://'],
    ['DATABASE_URL_POOLED', 'postgresql://router@db.example.test/db_SENTINEL?sslmode=require', 'the database URL has no password'],
    ['DATABASE_URL', 'postgresql://:pw@db.example.test/db_SENTINEL?sslmode=require', 'the database URL has no user'],
    ['DATABASE_URL', 'postgresql:///db_SENTINEL?sslmode=require', 'the database URL has no host'],
    ['DATABASE_URL', local(''), 'the database URL must set sslmode=require or sslmode=verify-full'],
    ['DATABASE_URL', local('?sslmode=verify-ca'), 'the database URL must set sslmode=require or sslmode=verify-full'],
    ['DATABASE_URL', local('?sslmode=require&sslrootcert=/x'), 'the router would refuse this database URL'],
    ['DATABASE_URL_POOLED', neon('ep-fake-sentinel-0001'), 'DATABASE_URL_POOLED must be the pooled endpoint (a -pooler host)'],
    ['DATABASE_URL', neon('ep-fake-sentinel-0001-pooler'), 'DATABASE_URL must be the direct endpoint (not a -pooler host)'],
  ];
  for (const [name, url, reason] of refused) {
    const entry = DATABASE.find((e) => e.env === name);
    const r = await runCopy(['--manifest', await manifest([entry]), '--yes'], { input: `${name}=${url}\n` });
    assert.equal(r.code, 3, `${url}: ${r.stdout}${r.stderr}`);
    assert.ok(r.stdout.includes(`STOPPED at ${name} (source stdin-env:${name}): ${reason}`), `${url}: ${r.stdout}`);
    assert.deepEqual(adds(await fakes.calls()), []);
    await assertNoSecretLeaked([url, new URL(url).host].filter(Boolean), r);
  }
  const ok = await runCopy(['--manifest', await manifest(DATABASE), '--check'], { input: databaseDocument(neon('ep-fake-sentinel-0001-pooler'), neon('ep-fake-sentinel-0001')) });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);

  // The document itself: a variable missing or set twice, or a malformed line, stops the run.
  for (const [input, reason] of [
    [`DATABASE_URL=${DIRECT}\n`, 'DATABASE_URL_POOLED is not set in the dotenv document on stdin'],
    [`DATABASE_URL_POOLED=${POOLED}\nDATABASE_URL_POOLED=${POOLED}\n`, 'the dotenv document on stdin: DATABASE_URL_POOLED is set more than once'],
    [`DATABASE_URL_POOLED=${POOLED}\n${DIRECT}\n`, 'the dotenv document on stdin: line 2 is not a NAME=value line'],
  ]) {
    const r = await runCopy(['--manifest', await manifest(DATABASE), '--yes'], { input });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.ok(r.stdout.includes(`STOPPED at DATABASE_URL_POOLED (source stdin-env:DATABASE_URL_POOLED): ${reason}`), r.stdout);
    assert.deepEqual(adds(await fakes.calls()), []);
    await assertNoSecretLeaked([POOLED, DIRECT], r);
  }
});

test('without a pinned project nothing runs, so keys never go to an inherited or linked project', { skip }, async () => {
  // The operator's environment names one project, the working directory is linked to another.
  const linked = path.join(scratch.root, 'linked');
  await writeLink(linked, OTHER_LINK);
  const unpinned = await manifest([FULL[2]], { project: undefined });
  /** @type {Record<string, string[]>} */
  const targets = {};
  /** @type {Record<string, number | null>} */
  const codes = {};
  for (const [name, options] of /** @type {const} */ ([['inherited', { env: INHERITED }], ['linked', { cwd: linked }]])) {
    await configure();
    const r = await runCopy(['--manifest', unpinned, '--yes'], options);
    codes[name] = r.code;
    targets[name] = (await fakes.calls()).filter((c) => c.tool === 'vercel').map((c) => `${c.argv.join(' ')} -> ${c.target}`);
    if (r.code === 2) assert.match(r.stderr, /manifest: "project" is required/);
  }
  assert.deepEqual(targets, { inherited: [], linked: [] }, 'vercel ran against a project the manifest does not name');
  assert.deepEqual(codes, { inherited: 2, linked: 2 });
});

test('a different project in the environment or in the repository link stops the run before anything is read', { skip }, async () => {
  const file = await manifest(FULL);
  /** @type {[string, {env?: Record<string, string>}, unknown, RegExp][]} */
  const cases = [
    ['env project', { env: { VERCEL_PROJECT_ID: 'prj_OtherProject' } }, null, /^STOPPED at project pin: VERCEL_PROJECT_ID in the environment is prj_OtherProject, but the manifest pins prj_TestProject01; /m],
    ['env org', { env: { VERCEL_ORG_ID: 'team_OtherOrg', VERCEL_PROJECT_ID: PROJECT.projectId } }, null, /^STOPPED at project pin: VERCEL_ORG_ID in the environment is team_OtherOrg, but the manifest pins team_TestOrg01; /m],
    ['env not an id', { env: { VERCEL_PROJECT_ID: VALUES.unrelated } }, null, /^STOPPED at project pin: VERCEL_PROJECT_ID in the environment is not a Vercel id, but the manifest pins prj_TestProject01; /m],
    ['link project', {}, { orgId: PROJECT.orgId, projectId: 'prj_LinkedProject' }, /^STOPPED at project pin: \.vercel\/project\.json links prj_LinkedProject \(org team_TestOrg01\), but the manifest pins prj_TestProject01 \(org team_TestOrg01\); /m],
    ['link org', {}, { orgId: 'team_LinkedOrg', projectId: PROJECT.projectId }, /^STOPPED at project pin: \.vercel\/project\.json links prj_TestProject01 \(org team_LinkedOrg\), /m],
    ['link malformed', {}, '{"orgId": ', /^STOPPED at project pin: \.vercel\/project\.json is not valid JSON; /m],
  ];
  for (const mode of ['--check', '--yes']) {
    for (const [name, options, link, expected] of cases) {
      await configure();
      if (link !== null) await writeLink(repo, link);
      try {
        const r = await runCopy(['--manifest', file, mode], { input: VALUES.password, ...options });
        assert.equal(r.code, 3, `${mode} ${name}: ${r.stdout}${r.stderr}`);
        assert.match(r.stdout, expected, `${mode} ${name}`);
        assert.deepEqual(await fakes.calls(), [], `${mode} ${name}: no vercel command ran and no source was read`);
        assert.ok(!(r.stdout + r.stderr).includes(MARKER), 'a non-id value was echoed');
      } finally {
        await rm(path.join(repo, '.vercel'), { recursive: true, force: true });
      }
    }
  }
});

test('a matching environment and link run normally: vercel gets the pinned ids, from the repository root', { skip }, async () => {
  await configure();
  await writeLink(repo, { ...PROJECT, projectName: 'test-project' });
  const elsewhere = path.join(scratch.root, 'linked'); // the operator's cwd, linked to another project
  await writeLink(elsewhere, OTHER_LINK);
  try {
    const r = await runCopy(['--manifest', await manifest([FULL[2], FULL[3]]), '--yes'], { cwd: elsewhere, env: { VERCEL_ORG_ID: PROJECT.orgId, VERCEL_PROJECT_ID: PROJECT.projectId } });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const calls = await fakes.calls();
    const vercel = calls.filter((c) => c.tool === 'vercel');
    assert.deepEqual(vercel.map((c) => `${c.argv.join(' ')} -> ${c.target}`), [
      `env add --help -> ${PINNED}`,
      `env ls production -> ${PINNED}`,
      `env add ANTHROPIC_API_KEY production --force --sensitive -> ${PINNED}`,
      `env add GEMINI_API_KEY production --force --sensitive -> ${PINNED}`,
      `env ls production -> ${PINNED}`,
    ]);
    const root = await realpath(repo);
    for (const c of vercel) {
      assert.deepEqual(c.ids, PROJECT);
      assert.equal(await realpath(c.cwd), root);
    }
    for (const c of calls.filter((x) => x.tool !== 'vercel')) assert.deepEqual(c.env.filter((n) => n.startsWith('VERCEL_')), [], `${c.tool} got Vercel ids`);
  } finally {
    await rm(path.join(repo, '.vercel'), { recursive: true, force: true });
  }
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

  // A symlink from an allowed directory into a temp dir is refused after realpath. The target is
  // under the script's own $TMPDIR (`tmpdir`), a root it prohibits; this process's os.tmpdir() is
  // prohibited only by chance (/var/folders on stock macOS), not under another TMPDIR.
  const outside = await mkdtemp(path.join(tmpdir, 'copy-keys-outside-'));
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
    ['"env" must be one of', [{ env: 'MISTRAL_API_KEY', source: { type: 'stdin' } }]],
    ['appears more than once', [{ env: 'ANTHROPIC_API_KEY', source: KEYCHAIN }, { env: 'ANTHROPIC_API_KEY', source: { type: 'op', ref: OP_REF } }]],
    ['at most one entry may read stdin', [stdin, { env: 'ANTHROPIC_API_KEY', source: { type: 'stdin' } }]],
    ['cannot share stdin', [stdin, { env: 'DATABASE_URL_POOLED', source: { type: 'stdin-env', var: 'DATABASE_URL_POOLED' } }]],
    ['stdin-env "var" must be a variable name', [{ env: 'DATABASE_URL', source: { type: 'stdin-env', var: 'DATABASE URL' } }]],
    ['"generate" is for ROUTER_SECRET', [{ env: 'ROUTER_SECRET', source: { type: 'generate', bytes: 32 } }]],
    ['not both', [stdin, { env: 'ROUTER_PASSWORD', source: KEYCHAIN }]],
    ['"environment" must be "production"', [stdin], { environment: 'preview' }],
    ['manifest: "project" is required', [stdin], { project: undefined }],
    ['manifest: "project" must be an object', [stdin], { project: PROJECT.projectId }],
    ['manifest "project": unknown key "name"', [stdin], { project: { ...PROJECT, name: 'x' } }],
    ['manifest "project": "projectId" is required', [stdin], { project: { orgId: PROJECT.orgId } }],
    ['manifest "project": "orgId" must be', [stdin], { project: { ...PROJECT, orgId: 'team Test' } }],
    ['manifest "project": "projectId" must be', [stdin], { project: { ...PROJECT, projectId: 'TestProject01' } }],
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

test('the manifest accepts OpenAI and all provider fallback names', () => {
  const names = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY_2', 'GEMINI_API_KEY_2', 'OPENROUTER_API_KEY_2', 'OPENAI_API_KEY_2'];
  const entries = names.map((env) => ({ env, source: { type: 'stdin-env', var: env } }));
  const result = validateManifest({ version: 1, environment: 'production', project: PROJECT, entries });
  assert.deepEqual(result.entries.map((entry) => entry.env), names);
});

test('admin passwords accept stdin hashing and cannot combine plaintext with a hash', () => {
  const base = { version: 1, environment: 'production', project: PROJECT };
  const entry = { env: 'ROUTER_ADMIN_PASSWORD_HASH', source: { type: 'stdin' }, transform: 'scrypt-hash' };
  assert.equal(validateManifest({ ...base, entries: [entry] }).entries[0].transform, 'scrypt-hash');
  assert.throws(() => validateManifest({ ...base, entries: [entry, { env: 'ROUTER_ADMIN_PASSWORD', source: KEYCHAIN }] }), /not both/);
});
