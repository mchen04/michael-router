// scripts/scan-secrets.mjs against throwaway git repositories with planted findings: in history
// only, in the working tree only, in a commit message, in a deleted file, on another branch, in an
// annotated tag and in a file name. Every planted value is built at runtime (this file contains
// none), and no part of any planted value may appear in the scanner's output.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { hashPassword } from '../../src/auth.js';
import { FAST_SCRYPT } from '../helpers/fixtures.js';

const SCRIPT = fileURLToPath(new URL('../../scripts/scan-secrets.mjs', import.meta.url));
const skip = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return false;
  } catch {
    return 'git is not available';
  }
})();

const b64url = (/** @type {number} */ n) => randomBytes(n).toString('base64url');
const join = (/** @type {string[]} */ ...parts) => parts.join('');
// Real-shaped values, assembled so that no source line here matches a rule.
const PLANTED = {
  anthropic: join('sk-ant-', 'api03-', b64url(72)),
  openrouter: join('sk-or-', 'v1-', randomBytes(32).toString('hex')),
  google: join('AI', 'za', b64url(27).slice(0, 35)),
  pem: join('-----BEGIN ', 'PRIVATE KEY-----\n', randomBytes(48).toString('base64'), '\n-----END ', 'PRIVATE KEY-----\n'),
  upstash: join('KV_REST_', 'API_TOKEN="', b64url(40), 'Aa1"'),
  vercel: join('VERCEL_', 'TOKEN=', randomBytes(16).toString('hex')),
  home: join('/Us', 'ers/planted-', randomBytes(4).toString('hex'), '/project'),
  homeBare: join('/ho', 'me/planted-', randomBytes(4).toString('hex')),
  oauth: join('sk-ant-', 'oat01-', b64url(70)),
  redis: join('redis', 's://default:', b64url(24), '@db.example.com:6379'),
  hash: '', // generated in before()
  literal1: `literal-one-${b64url(18)}`,
  literal2: `literal+two/${b64url(18)}=`,
  literal3: `literal-three-${randomBytes(9).toString('hex')}`,
  literal4: `literal"four\\${randomBytes(9).toString('hex')}`,
};

/** @type {string} */
let base;
/** @type {Record<string, string>} */
let gitEnv;

before(async () => {
  if (skip) return;
  base = await mkdtemp(path.join(os.tmpdir(), 'scan-secrets-'));
  await mkdir(path.join(base, 'home'));
  gitEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: path.join(base, 'home'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  PLANTED.hash = await hashPassword('planted-password-for-scan', FAST_SCRYPT);
});
after(async () => {
  if (base) await rm(base, { recursive: true, force: true });
});

/** @param {string} cwd @param {string[]} args */
const git = (cwd, args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

/** @param {string} dir @param {Record<string, string>} files */
async function put(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
}

/** @param {string} cwd @param {string[]} args @param {string} [input] */
function runScan(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd, env: gitEnv, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    if (input !== undefined) child.stdin?.end(input);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('scan-secrets timed out'));
    }, 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(/** @type {{code: number, stdout: string, stderr: string}} */ ({ code, stdout, stderr }));
    });
  });
}

/** No 10-character window of any planted value appears in the output. @param {string} output */
function assertNoPlantedText(output) {
  for (const [name, value] of Object.entries(PLANTED)) {
    for (let i = 0; i + 10 <= value.length; i++) {
      assert.ok(!output.includes(value.slice(i, i + 10)), `part of the planted ${name} value reached the output`);
    }
  }
}

/** @param {string} stdout */
const findingLines = (stdout) =>
  stdout
    .split('\n')
    .filter((l) => l !== '' && !l.startsWith('scan: '))
    .sort();

test('finds planted values in history, deleted files, messages, tags, other refs, the tree and file names', { skip }, async () => {
  const repo = path.join(base, 'planted');
  await mkdir(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  await put(repo, { '.gitignore': '.env.local\n', 'README.md': 'hello\n', 'config/old.env': `NAME=x\nANTHROPIC_KEY=${PLANTED.anthropic}\n` });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'first']);
  const c1 = git(repo, ['rev-parse', 'HEAD']);

  await put(repo, { 'config/old.env': 'NAME=x\n', 'keys/deploy.pem': PLANTED.pem });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'drop the key from the env file']);
  const c2 = git(repo, ['rev-parse', 'HEAD']);

  git(repo, ['rm', '-q', 'keys/deploy.pem']);
  await writeFile(path.join(base, 'message.txt'), `remove the deploy key\n\n${PLANTED.google}\n`);
  git(repo, ['commit', '-q', '-F', path.join(base, 'message.txt')]);
  const c3 = git(repo, ['rev-parse', 'HEAD']);

  git(repo, ['checkout', '-q', '-b', 'side']);
  const embedded = Buffer.concat([randomBytes(1), Buffer.from(PLANTED.literal1), randomBytes(5)]).toString('base64');
  await put(repo, { 'side.txt': `blob=${embedded}\n`, 'url.txt': `https://example.com/cb?token=${encodeURIComponent(PLANTED.literal2)}\n` });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'side work']);
  const side = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['tag', '-a', 'v1', '-m', `release\n\n${PLANTED.vercel}`]);
  const tag = git(repo, ['rev-parse', 'v1']);

  await put(repo, {
    'new.txt': `one\ntwo\nkey: ${PLANTED.openrouter}\n`,
    'hash.txt': `${PLANTED.hash}\nscrypt$10$8$1$AAAAAAAA$BBBBBBBB\n`,
    'notes.md': `see ${PLANTED.home}/x\nhttps://example.com/home/someone/page and /home/<name>/ are fine\n`,
    'store.txt': `${PLANTED.upstash}\n`,
    '.env.local': `${PLANTED.upstash}\n${PLANTED.anthropic}\n`, // ignored: never scanned
    [`leak-${PLANTED.literal3}.txt`]: 'nothing inside\n',
  });

  const s = (/** @type {string} */ id) => id.slice(0, 12);
  const patterns = [
    `${s(c1)}:config/old.env:2 anthropic-key`,
    `${s(c2)}:keys/deploy.pem:1 private-key`,
    `${s(c3)}:(message):3 google-api-key`,
    `${s(tag)}:(tag message):3 vercel-token`,
    'worktree:new.txt:3 openrouter-key',
    'worktree:hash.txt:1 scrypt-hash',
    'worktree:notes.md:1 home-path',
    'worktree:store.txt:1 upstash-token',
  ].sort();

  const plain = await runScan(repo, []);
  assert.equal(plain.code, 1, plain.stderr);
  assert.deepEqual(findingLines(plain.stdout), patterns);
  assert.match(plain.stdout, /^scan: 8 findings \(worktree 4, history 2, commit and tag objects 2\); 8 files, \d+ blobs, 4 commits, 1 tags scanned$/m);

  const literals = [PLANTED.literal1, PLANTED.literal2, PLANTED.literal3].join('\n');
  const withLiterals = await runScan(repo, ['--literals-stdin'], `${literals}\n`);
  assert.equal(withLiterals.code, 1, withLiterals.stderr);
  assert.deepEqual(
    findingLines(withLiterals.stdout),
    [...patterns, `${s(side)}:side.txt:1 literal-1-base64`, `${s(side)}:url.txt:1 literal-2-urlencoded`, 'worktree:[redacted path]:0 literal-3'].sort(),
  );
  for (const r of [plain, withLiterals]) assertNoPlantedText(r.stdout + r.stderr);
});

test('matches escaped, encoded and bare forms, and flags archives it cannot read', { skip }, async () => {
  const repo = path.join(base, 'forms');
  await mkdir(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  const pct = encodeURIComponent(PLANTED.literal2).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
  await put(repo, {
    'rules.txt': [
      `cd ${PLANTED.homeBare}`,
      `path = "${PLANTED.homeBare}"`,
      `HOME=${PLANTED.homeBare} node x.js`,
      PLANTED.hash.replaceAll('$', '\\$'),
      `hash=${PLANTED.hash.replaceAll('$', '%24')}`,
      `token: ${PLANTED.oauth}`,
      `REDIS_URL=${PLANTED.redis}`,
    ].join('\n'),
    'escaped.json': `{"a":"${PLANTED.literal2.replaceAll('/', '\\/')}","b":${JSON.stringify(PLANTED.literal4)}}\n`,
    'lower.txt': `cb?token=${pct}\n`,
  });
  await writeFile(path.join(repo, 'bundle.gz'), gzipSync(PLANTED.openrouter));
  await writeFile(path.join(repo, 'report.docx'), Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), randomBytes(64)]));

  const r = await runScan(repo, ['--literals-stdin'], `${PLANTED.literal2}\n${PLANTED.literal4}\n`);
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(
    findingLines(r.stdout),
    [
      'worktree:rules.txt:1 home-path',
      'worktree:rules.txt:2 home-path',
      'worktree:rules.txt:3 home-path',
      'worktree:rules.txt:4 scrypt-hash',
      'worktree:rules.txt:5 scrypt-hash',
      'worktree:rules.txt:6 anthropic-oauth-token',
      'worktree:rules.txt:7 redis-url-credentials',
      'worktree:escaped.json:1 literal-1-json',
      'worktree:escaped.json:1 literal-2-json',
      'worktree:lower.txt:1 literal-1-urlencoded',
      'worktree:bundle.gz:0 unscanned-archive',
      'worktree:report.docx:0 unscanned-archive',
    ].sort(),
  );
  assertNoPlantedText(r.stdout + r.stderr);
});

test('reaches every path and object: renames, symlinks, gitlinks, staged files, tagged blobs and trees, nested tags', { skip }, async () => {
  const repo = path.join(base, 'objects');
  await mkdir(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  await put(repo, { 'a.txt': 'plain\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'first']);
  // The same blob under a new name: only the path carries the finding.
  const renamed = `${PLANTED.openrouter}.txt`;
  git(repo, ['mv', 'a.txt', renamed]);
  git(repo, ['commit', '-q', '-m', 'rename']);
  const c2 = git(repo, ['rev-parse', 'HEAD']);
  await put(repo, { 'gone.txt': 'about to lose its object\n' });
  git(repo, ['add', 'gone.txt']);
  git(repo, ['commit', '-q', '-m', 'third']);
  const c3 = git(repo, ['rev-parse', 'HEAD']);

  // A tag only reachable through another tag, a tagged blob and a tagged tree.
  git(repo, ['tag', '-a', 'inner', '-m', PLANTED.google, 'HEAD']);
  const inner = git(repo, ['rev-parse', 'inner']);
  git(repo, ['-c', 'advice.nestedTag=false', 'tag', '-a', 'outer', '-m', 'outer', 'inner']);
  git(repo, ['tag', '-d', 'inner']);
  await writeFile(path.join(base, 'blob.txt'), `${PLANTED.anthropic}\n`);
  const blob = git(repo, ['hash-object', '-w', path.join(base, 'blob.txt')]);
  git(repo, ['tag', 'loose-blob', blob]);
  await writeFile(path.join(base, 'pem.txt'), PLANTED.pem);
  const pem = git(repo, ['hash-object', '-w', path.join(base, 'pem.txt')]);
  const tree = execFileSync('git', ['mktree'], { cwd: repo, env: gitEnv, input: `100644 blob ${pem}\tin-tree.txt\n`, encoding: 'utf8' }).trim();
  git(repo, ['tag', 'loose-tree', tree]);

  // Working-tree entries that are not regular files: a symlink, a staged file deleted from
  // disk and a gitlink.
  await symlink('README.md', path.join(repo, `${PLANTED.google}-link`));
  await put(repo, { [`${PLANTED.anthropic}.txt`]: 'x\n' });
  git(repo, ['add', `${PLANTED.anthropic}.txt`]);
  await unlink(path.join(repo, `${PLANTED.anthropic}.txt`));
  git(repo, ['update-index', '--add', '--cacheinfo', `160000,${c2},${PLANTED.hash}`]);

  // An object the repository has lost.
  const gone = git(repo, ['rev-parse', 'HEAD:gone.txt']);
  await rm(path.join(repo, '.git', 'objects', gone.slice(0, 2), gone.slice(2)), { force: true });

  const s = (/** @type {string} */ id) => id.slice(0, 12);
  const r = await runScan(repo, []);
  assert.equal(r.code, 1, r.stderr);
  assert.deepEqual(
    findingLines(r.stdout),
    [
      'worktree:[redacted path]:0 openrouter-key',
      'worktree:[redacted path]:0 google-api-key',
      'worktree:[redacted path]:0 anthropic-key',
      'worktree:[redacted path]:0 scrypt-hash',
      `${s(c2)}:[redacted path]:0 openrouter-key`,
      `${s(c3)}:gone.txt:0 unscanned-missing-object`,
      `${s(inner)}:(tag message):1 google-api-key`,
      `${s(blob)}:(object):1 anthropic-key`,
      `${s(pem)}:in-tree.txt:1 private-key`,
    ].sort(),
  );
  assert.match(r.stdout, /^scan: 9 findings \(worktree 4, history 4, commit and tag objects 1\); .* 3 commits, 2 tags scanned$/m);
  assertNoPlantedText(r.stdout + r.stderr);
});

test('a repository with only fake-shaped fixtures and placeholders is clean', { skip }, async () => {
  const repo = path.join(base, 'clean');
  await mkdir(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  await put(repo, {
    'fixtures.js': [
      "export const KEY = 'sk-ant-fake-SENTINEL-env-claude-0001';",
      "export const GEMINI = 'AIzaFAKE-SENTINEL-env-gemini-01';",
      "export const OPENROUTER = 'sk-or-fake-SENTINEL-env-openrouter-0001';",
      "const redaction = 'sk-ant-api03-abc and sk-or-v1-deadbeef';",
      "const env = { KV_REST_API_TOKEN: 'store-token-SENTINEL-for-the-fake-upstash' };",
      "const oauth = 'sk-ant-oat01-abc';",
    ].join('\n'),
    'docs.md': [
      'ROUTER_PASSWORD_HASH = `scrypt$<logN>$<r>$<p>$<salt>$<hash>` or "scrypt\\$<logN>\\$..."; KV_REST_API_TOKEN=<token>',
      'paths like /Users/<name>/ or /Users/<name>, HOME=/home/<user>, /Users/Shared and ~/.config/',
      'redis://default:<password>@<host>:6379 or rediss://localhost:6379/0',
    ].join('\n'),
  });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'fixtures']);
  const r = await runScan(repo, []);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^scan: 0 findings /m);
});

test('outside a git work tree it scans the files on disk, honoring the top-level .gitignore', { skip }, async () => {
  const dir = path.join(base, 'plain-dir');
  await put(dir, { '.gitignore': 'evidence/\n*.log\n', 'src/a.txt': `x\n${PLANTED.openrouter}\n`, 'evidence/raw.txt': PLANTED.openrouter, 'debug.log': PLANTED.openrouter, 'node_modules/m/index.js': PLANTED.openrouter });
  const r = await runScan(dir, []);
  assert.equal(r.code, 1);
  assert.deepEqual(findingLines(r.stdout), ['worktree:src/a.txt:2 openrouter-key']);
  assert.match(r.stderr, /not a git work tree/);
  assertNoPlantedText(r.stdout + r.stderr);
});

test('usage errors exit 2 without echoing arguments or literals', { skip }, async () => {
  const repo = base;
  const value = await runScan(repo, [PLANTED.literal3]);
  assert.equal(value.code, 2);
  assert.ok(!value.stderr.includes(PLANTED.literal3) && value.stdout === '');
  const short = await runScan(repo, ['--literals-stdin'], `${PLANTED.literal1}\nshort\n`);
  assert.equal(short.code, 2);
  assert.match(short.stderr, /stdin line 2: literals must be at least 8 characters/);
  assertNoPlantedText(value.stderr + short.stderr + short.stdout);
});
