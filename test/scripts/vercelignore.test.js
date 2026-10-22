// .vercelignore is the deployment's upload allowlist. It uses gitignore syntax, so it is evaluated
// here with git's own ignore engine in a temporary repository (no network, no `vercel` binary):
// the tracked files that would upload are exactly the files the deployment needs at runtime, and
// secret-shaped or local files are excluded wherever they are planted. Vercel's own reading of the
// file is confirmed only at deploy time, from the deployment's source listing (DEPLOY.md step 5).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const IGNORE = path.join(REPO, '.vercelignore');
/** Local files that must never upload, wherever they appear. */
const PLANTED = [
  '.env',
  '.env.production.local',
  'public/.env',
  'src/.env.local',
  'scripts/key-sources.json',
  'router-password.hash',
  'api/x.hash',
  'evidence/live/x.json',
  'evidence/speed/round-0/samples.json',
  'docs/x',
  'test/x',
  'node_modules/x',
  'api/key-sources.json',
  'api/database-sources.json',
  'public/server.pem',
  'src/tls.key',
  '.vercel/project.json',
  'tmp/x',
];

let dir = '';
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vercelignore-'));
});
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/**
 * git with no system or user configuration, so only the files named here apply.
 * @param {string[]} args @param {{cwd?: string, input?: string, ok?: number[]}} [options]
 */
function git(args, { cwd = dir, input, ok = [0] } = {}) {
  const env = { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, LC_ALL: 'C' };
  const r = spawnSync('git', args, { cwd, env, input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.ok(r.status !== null && ok.includes(r.status), `git ${args.join(' ')}: ${r.error?.message ?? r.stderr}`);
  return r.stdout;
}
/** @param {string} out NUL-separated paths */
const paths = (out) => out.split('\0').filter(Boolean);

/** Tracked files; in a copy without git metadata, the files git would track (by .gitignore). */
function trackedFiles() {
  const prefix = git(['rev-parse', '--show-prefix'], { cwd: REPO, ok: [0, 128] });
  if (prefix === '\n') return paths(git(['ls-files', '-z'], { cwd: REPO }));
  const meta = path.join(dir, 'meta');
  git(['-c', 'init.defaultBranch=main', 'init', '-q', meta]);
  return paths(git(['--git-dir', path.join(meta, '.git'), '--work-tree', REPO, 'ls-files', '-z', '--others', '--exclude-standard'], { cwd: REPO }));
}

const IMPORTS = [
  /^\s*import\s+[\w*\s{},$]+?\s+from\s*(['"])([^'"]+)\1/gm,
  /^\s*import\s*(['"])([^'"]+)\1/gm,
  /^\s*export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[\w\s,$]*\})\s+from\s*(['"])([^'"]+)\1/gm,
  /\b(?:import|require)\(\s*(['"])([^'"]+)\1\s*\)/g,
];

/**
 * The deployment's runtime files: the import closure of every function in vercel.json (relative
 * imports and require()d JSON such as package.json and src/pricing.json), the static output
 * directory, and the install and platform configuration.
 * @param {string[]} tracked
 */
function runtimeFiles(tracked) {
  const vercel = JSON.parse(readFileSync(path.join(REPO, 'vercel.json'), 'utf8'));
  const deps = Object.keys(JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')).dependencies ?? {});
  const files = new Set(['package.json', 'package-lock.json', 'vercel.json']);
  for (const f of tracked) if (f.startsWith(`${vercel.outputDirectory}/`)) files.add(f);
  const queue = Object.keys(vercel.functions);
  assert.ok(queue.length > 0, 'vercel.json declares the functions');
  while (queue.length) {
    const file = /** @type {string} */ (queue.pop());
    if (files.has(file)) continue;
    assert.ok(existsSync(path.join(REPO, file)), `${file} is imported but does not exist`);
    files.add(file);
    if (!file.endsWith('.js')) continue;
    const text = readFileSync(path.join(REPO, file), 'utf8');
    for (const re of IMPORTS) {
      for (const [, , spec] of text.matchAll(re)) {
        if (spec.startsWith('.')) queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)));
        else {
          // Any other file read at runtime would need node:fs, which the walk above cannot follow.
          assert.doesNotMatch(spec, /^(?:node:)?fs(?:\/promises)?$/, `${file} reads files at runtime; add them to this walk`);
          assert.ok(spec.startsWith('node:') || deps.includes(spec), `${file} imports ${spec}, neither a Node built-in nor a package.json dependency`);
        }
      }
    }
  }
  return files;
}

test('.vercelignore uploads exactly the runtime files and never a secret-shaped or local file', () => {
  assert.ok(existsSync(IGNORE), '.vercelignore exists at the repository root');
  const tracked = trackedFiles();
  const runtime = runtimeFiles(tracked);
  for (const f of runtime) assert.ok(tracked.includes(f), `${f} is needed at runtime but not tracked`);

  // The tracked tree and the planted files, in a fresh repository with .vercelignore as its only ignore file.
  const work = path.join(dir, 'work');
  git(['-c', 'init.defaultBranch=main', 'init', '-q', work]);
  for (const f of [...tracked, ...PLANTED]) {
    mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
    writeFileSync(path.join(work, f), '');
  }
  const ignoreFile = ['-c', `core.excludesFile=${IGNORE}`];
  const ignored = new Set(paths(git([...ignoreFile, 'check-ignore', '--no-index', '-z', '--stdin'], { cwd: work, input: [...tracked, ...PLANTED].map((f) => `${f}\0`).join(''), ok: [0, 1] })));

  const uploads = tracked.filter((f) => !ignored.has(f)).sort();
  assert.deepEqual(uploads, [...runtime].sort(), 'the tracked files that upload are exactly the runtime files');
  assert.deepEqual(PLANTED.filter((f) => !ignored.has(f)), [], 'these planted files would upload');

  // A directory walk with the same file (as a deploy walks the tree) agrees.
  const walked = paths(git([...ignoreFile, 'ls-files', '-z', '--others', '--exclude-standard'], { cwd: work })).sort();
  assert.deepEqual(walked, uploads);
});
