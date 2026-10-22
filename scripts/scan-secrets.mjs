#!/usr/bin/env node
// Secret scan of the working tree and the full git history (DESIGN §13). Zero dependencies.
//
//   node scripts/scan-secrets.mjs [--literals-stdin]
//
// Scans the git repository that contains the current directory:
//   - the working tree: `git ls-files -co --exclude-standard` (tracked and untracked, not ignored),
//     the path of every entry (also symlinks, gitlinks, files deleted from disk), the content of
//     regular files and the target text of symlinks;
//   - every path of every commit, once, at the oldest commit that has it;
//   - every object reachable from any ref (`git rev-list --objects --all`), also blobs and trees
//     tagged directly and tags reached only through another tag; each distinct blob once, reported
//     at the oldest commit and path where it appears (else under its own id);
//   - every commit and tag object (message and headers).
// Missing objects are reported (`unscanned-missing-object`) and never fetched; compressed
// archives are reported as `unscanned-archive`.
// Outside a git work tree only the files on disk are scanned (skipping .git, node_modules and
// the patterns of the top-level .gitignore), with a note on stderr.
//
// Pattern rules: real-shaped Anthropic keys and OAuth tokens, OpenRouter and Google API keys,
// complete scrypt$ password hashes (also escaped or URL-encoded), PEM private-key blocks, Upstash
// REST and Vercel tokens assigned to their variable names, redis:// URL credentials, Postgres
// credentials (postgres:// URLs in any case, JSON-escaped or jdbc:, with a password in the user
// info or a `password` parameter; PGPASSWORD given a value; libpq `host=… password=…` strings;
// never a `${…}` template placeholder, nor a host under the reserved .test TLD, which never
// resolves: test fixtures), and absolute home-directory paths (/Users/<name>, /home/<name>).
// --literals-stdin: also look for exact values read from stdin (one per line, never argv), in
// their plain, base64, base64url, URL-encoded and JSON-escaped forms.
//
// Output: one `<location>:<path>:<line> <rule>` line per finding (location = `worktree`, a
// commit, or a tag object) and a summary count. Never the matched text or any part of it.
// Exit codes: 0 clean, 1 findings, 2 usage or git error.
import { Buffer } from 'node:buffer';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
export const EXIT = Object.freeze({ CLEAN: 0, FINDINGS: 1, USAGE: 2 });
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_LITERALS_BYTES = 1024 * 1024;
const MIN_LITERAL_LENGTH = 8;
const GIT_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_CONFIG_HOME'];
const GIT_FLAGS = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false'];

/** @param {string} s */
const b64len = (s) => Buffer.from(s, 'base64url').length;
/** A template placeholder such as `${password}`, not a value. @param {string} s */
const isTemplate = (s) => /^\$\{[^}]*\}$/.test(s);
/** A host under the reserved .test TLD (RFC 6761: never resolves): a test fixture. @param {string} host */
const isTestHost = (host) => /\.test$/i.test(host);

/**
 * @typedef {{id: string, re: RegExp, accept?: (m: RegExpExecArray) => boolean}} Rule
 * @type {Rule[]}
 */
export const RULES = [
  { id: 'anthropic-key', re: /sk-ant-(?:api|admin)\d\d-[A-Za-z0-9_-]{80,}/g },
  { id: 'anthropic-oauth-token', re: /sk-ant-(?:oat|ort)\d\d-[A-Za-z0-9_-]{40,}/g },
  { id: 'openrouter-key', re: /sk-or-v1-[0-9a-f]{64}/g },
  { id: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/g },
  // complete hashes only: salt >= 16 bytes and hash >= 32 bytes (what the server accepts); the
  // separators may be escaped (`\$`) or URL-encoded (`%24`)
  {
    id: 'scrypt-hash',
    re: /scrypt(\\*\$|%24)\d{1,3}\1\d{1,3}\1\d{1,3}\1([A-Za-z0-9_-]+)\1([A-Za-z0-9_-]+)/g,
    accept: (m) => b64len(m[2]) >= 16 && b64len(m[3]) >= 32,
  },
  { id: 'private-key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  // token-shaped values assigned to the store and Vercel token variables (conservative: by
  // context; store tokens must also look random: 32+ characters mixing digits and both cases)
  {
    id: 'upstash-token',
    re: /(?:UPSTASH_REDIS_REST_TOKEN|KV_REST_API_(?:READ_ONLY_)?TOKEN)["']?\s*[:=]\s*["']?([A-Za-z0-9_+/=-]{32,})/g,
    accept: (m) => /\d/.test(m[1]) && /[a-z]/.test(m[1]) && /[A-Z]/.test(m[1]),
  },
  { id: 'vercel-token', re: /(?:VERCEL_(?:OIDC_|ACCESS_)?TOKEN["']?\s*[:=]\s*["']?|--token[= ]["']?)[A-Za-z0-9_.-]{24,}/g },
  // credentials in redis:// and rediss:// URLs (placeholders such as <password> do not match)
  { id: 'redis-url-credentials', re: /\brediss?:\/\/[^\s:@/'"<>]*:[^\s@/'"<>]{8,}@/g },
  // credentials in postgres:// and postgresql:// URLs (any case, also jdbc:postgresql:// and
  // JSON-escaped slashes): a password in the user info or in a `password` parameter. Not reported:
  // a password that is a template placeholder (`${password}`), and a host under the reserved .test
  // TLD (RFC 6761: never resolves), which marks a test fixture.
  {
    id: 'postgres-url-credentials',
    re: /\bpostgres(?:ql)?:(?:\\*\/){2}[^\s:@/'"<>]*:([^\s@/'"<>]{8,})@([^\s/\\?#'"<>:]*)/gi,
    accept: (m) => !isTemplate(m[1]) && !isTestHost(m[2]),
  },
  {
    id: 'postgres-url-credentials',
    re: /\bpostgres(?:ql)?:(?:\\*\/){2}([^\s/\\?#'"<>]*)(?:[/\\][^\s?#'"<>]*)?\?(?:[^\s#'"<>]*?(?:&|;|\\u0026))?password=([^\s&#'"`<>\\]{8,})/gi,
    accept: (m) => !isTemplate(m[2]) && !isTestHost(m[1].replace(/^.*@/, '').replace(/:\d*$/, '')),
  },
  // PGPASSWORD given a value: `PGPASSWORD=…` (shell, dotenv), a quoted value after `=` or `:`
  // (code, JSON, YAML), or an unquoted YAML value `PGPASSWORD: …` with a digit in it (a bare
  // identifier there is code: `{PGPASSWORD: password}`). Not reported: shell and template
  // references (`$NAME`, `${…}`, `$(…)`, `%NAME%`) and <placeholders>.
  {
    id: 'pgpassword-value',
    re: /\bPGPASSWORD(?:=["'`]?([^\s"'`<>]{8,})|["']?\s*[:=]\s*["'`]([^\s"'`<>]{8,})|["']?:[ \t]+([^\s"'`<>,;)}\]]{8,}))/g,
    accept: (m) => {
      const value = m[1] ?? m[2] ?? m[3];
      return !/^(?:\$|%\w+%)/.test(value) && (m[3] === undefined || /\d/.test(value));
    },
  },
  // libpq keyword/value connection strings: a run of key=value words (no spaces around `=`, as
  // providers print them) that names both a host and a password, e.g. `host=… user=… password=…`.
  // Not inside a URL query (`?host=…&password=…`, the rules above). Not reported: a template
  // password, and a host under .test.
  {
    id: 'postgres-keyword-password',
    re: /(?<![\w.&?=/-])[a-z_]+=(?:'[^'\n]*'|[^\s'"`<>]*)(?:[ \t]+[a-z_]+=(?:'[^'\n]*'|[^\s'"`<>]*))+/g,
    accept: (m) => {
      const kv = new Map([...m[0].matchAll(/([a-z_]+)=('[^'\n]*'|\S*)/g)].map(([, k, v]) => [k, v.replace(/^'(.*)'$/, '$1')]));
      const host = kv.get('host');
      const password = kv.get('password');
      return Boolean(host) && password !== undefined && password.length >= 8 && !isTemplate(password) && !isTestHost(/** @type {string} */ (host));
    },
  },
  // absolute home directories, with or without a trailing slash (`HOME=/Users/<name>`); not inside
  // URLs or longer paths (the lookbehind), not /Users/Shared, not placeholders like /Users/<name>
  {
    id: 'home-path',
    re: /(?<![A-Za-z0-9_.~%-])\/(?:Users|home)\/(?!Shared(?![A-Za-z0-9._-]))[A-Za-z0-9._-]+(?=[/"'`\s<>()[\]{},;:|]|$)/gm,
  },
];

class UsageError extends Error {}

/**
 * @typedef {{rule: string, form: string}} LiteralForm
 * Every searchable form of each literal (as latin1 text of its UTF-8 bytes): plain; base64 and
 * base64url, as the characters that depend only on the value, for each of the three byte
 * alignments it can have inside a longer encoded string; URL-encoded with upper- and lowercase
 * hex; JSON-escaped (`\"`, `\\`), also with `\/` for `/`.
 * @param {string[]} literals
 * @returns {LiteralForm[]}
 */
export function literalForms(literals) {
  /** @type {LiteralForm[]} */
  const forms = [];
  literals.forEach((lit, i) => {
    const rule = `literal-${i + 1}`;
    const seen = new Set();
    /** @param {string} id @param {string} text */
    const add = (id, text) => {
      const form = Buffer.from(text, 'utf8').toString('latin1');
      if (form.length >= MIN_LITERAL_LENGTH && !seen.has(form)) {
        seen.add(form);
        forms.push({ rule: id, form });
      }
    };
    add(rule, lit);
    const bytes = Buffer.from(lit, 'utf8');
    for (const encoding of /** @type {const} */ (['base64', 'base64url'])) {
      for (let k = 0; k < 3; k++) {
        const enc = Buffer.concat([Buffer.alloc(k), bytes]).toString(encoding).replace(/=+$/, '');
        add(`${rule}-${encoding}`, enc.slice([0, 2, 3][k], Math.floor((8 * (k + bytes.length)) / 6)));
      }
    }
    const url = encodeURIComponent(lit);
    add(`${rule}-urlencoded`, url);
    add(`${rule}-urlencoded`, url.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
    const json = JSON.stringify(lit).slice(1, -1);
    add(`${rule}-json`, json);
    add(`${rule}-json`, json.replaceAll('/', '\\/'));
  });
  return forms;
}

/** Compressed archives (zip and its docx/xlsx/jar kin, gzip, bzip2, xz, zstd, 7z), by magic bytes. */
const ARCHIVE_MAGIC = [[0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0x1f, 0x8b], [0x42, 0x5a, 0x68], [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], [0x28, 0xb5, 0x2f, 0xfd], [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]].map((m) => Buffer.from(m));
/** @param {Buffer} b */
const isArchive = (b) => ARCHIVE_MAGIC.some((m) => b.length >= m.length && b.subarray(0, m.length).equals(m));

/**
 * Findings in one text (latin1: one char per byte) as [line, rule] pairs, deduplicated.
 * @param {string} text @param {LiteralForm[]} forms
 * @returns {[number, string][]}
 */
export function scanText(text, forms) {
  /** @type {[number, string][]} */
  const hits = [];
  /** @type {number[] | null} */
  let starts = null;
  const lineOf = (/** @type {number} */ index) => {
    if (!starts) {
      starts = [0];
      for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
    }
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(text); m; m = rule.re.exec(text)) {
      if (!rule.accept || rule.accept(m)) hits.push([lineOf(m.index), rule.id]);
    }
  }
  for (const { rule, form } of forms) {
    for (let i = text.indexOf(form); i !== -1; i = text.indexOf(form, i + 1)) hits.push([lineOf(i), rule]);
  }
  const unique = new Map(hits.map((h) => [`${h[0]} ${h[1]}`, h]));
  return [...unique.values()].sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
}

function gitEnv() {
  /** @type {Record<string, string>} */
  const env = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' };
  for (const name of GIT_ENV) if (process.env[name]) env[name] = /** @type {string} */ (process.env[name]);
  return env;
}

/** @param {string} cwd @param {string[]} args @returns {Promise<Buffer>} */
async function git(cwd, args) {
  try {
    const { stdout } = await execFileP('git', [...GIT_FLAGS, ...args], { cwd, env: gitEnv(), encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = /** @type {any} */ (err);
    const why = e.code === 'ENOENT' ? 'git is not installed' : String(e.stderr ?? '').split('\n')[0].trim() || `exit ${e.code}`;
    throw new UsageError(`git ${args[0]} failed: ${why.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 200)}`);
  }
}

/** Run git with `input` on stdin. @param {string} cwd @param {string[]} args @param {string} input @returns {Promise<Buffer>} */
function gitWithInput(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...GIT_FLAGS, ...args], { cwd, env: gitEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    /** @type {Buffer[]} */
    const out = [];
    let stderr = '';
    child.stdout.on('data', (/** @type {Buffer} */ c) => out.push(c));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', (err) => reject(new UsageError(`git ${args[0]} failed: ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new UsageError(`git ${args[0]} failed: ${stderr.split('\n')[0].slice(0, 200)}`))));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/**
 * Stream objects through one `git cat-file --batch` process.
 * @param {string} cwd @param {string[]} ids
 * @param {(id: string, type: string, content: Buffer | null) => void} onObject content null when too large
 * @param {(id: string) => void} onMissing
 */
function catFile(cwd, ids, onObject, onMissing) {
  return new Promise((resolve, reject) => {
    if (ids.length === 0) return resolve(undefined);
    const child = spawn('git', [...GIT_FLAGS, 'cat-file', '--batch'], { cwd, env: gitEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    /** @type {Buffer[]} */
    let chunks = [];
    let length = 0;
    /** @type {{id: string, type: string, size: number} | null} */
    let header = null;
    let stderr = '';
    const pump = () => {
      for (;;) {
        if (!header) {
          const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length);
          chunks = length ? [all] : [];
          const nl = all.indexOf(10);
          if (nl === -1) return;
          const line = all.subarray(0, nl).toString('latin1');
          chunks = nl + 1 < all.length ? [all.subarray(nl + 1)] : [];
          length = all.length - nl - 1;
          const [id, type, size] = line.split(' ');
          if (type === 'missing') onMissing(id);
          if (type === 'missing' || size === undefined) continue;
          header = { id, type, size: Number(size) };
        }
        if (length < header.size + 1) return;
        const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length);
        const content = all.subarray(0, header.size);
        chunks = header.size + 1 < all.length ? [all.subarray(header.size + 1)] : [];
        length = all.length - header.size - 1;
        onObject(header.id, header.type, header.size > MAX_FILE_BYTES ? null : content);
        header = null;
      }
    };
    child.stdout.on('data', (/** @type {Buffer} */ c) => {
      chunks.push(c);
      length += c.length;
      pump();
    });
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', (err) => reject(new UsageError(`git cat-file failed: ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolve(undefined) : reject(new UsageError(`git cat-file failed: ${stderr.split('\n')[0].slice(0, 200)}`))));
    child.stdin.on('error', () => {});
    child.stdin.end(`${ids.join('\n')}\n`);
  });
}

// ------------------------------------------------------------------ fallback (no git)

/** The top-level .gitignore as matchers (no negation, no nested files). @param {string} root */
async function ignoreMatchers(root) {
  const text = await readFile(path.join(root, '.gitignore'), 'utf8').catch(() => '');
  /** @type {{re: RegExp, dirOnly: boolean, anchored: boolean}[]} */
  const out = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    const dirOnly = line.endsWith('/');
    line = line.replace(/\/+$/, '');
    const anchored = line.includes('/');
    line = line.replace(/^\//, '');
    const src = line.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
    out.push({ re: new RegExp(`^${src}$`), dirOnly, anchored });
  }
  return out;
}

/** @param {string} root @returns {Promise<string[]>} relative paths of regular files and symlinks */
async function walk(root) {
  const ignore = await ignoreMatchers(root);
  /** @param {string} rel @param {boolean} dir */
  const ignored = (rel, dir) => ignore.some((m) => (!m.dirOnly || dir) && m.re.test(m.anchored ? rel : path.posix.basename(rel)));
  /** @type {string[]} */
  const files = [];
  /** @param {string} rel */
  async function visit(rel) {
    for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name !== '.git' && e.name !== 'node_modules' && !ignored(r, true)) await visit(r);
      } else if ((e.isFile() || e.isSymbolicLink()) && !ignored(r, false)) files.push(r);
    }
  }
  await visit('');
  return files.sort();
}

// ------------------------------------------------------------------ main

/** @param {NodeJS.ReadableStream & {isTTY?: boolean}} stdin */
async function readLiterals(stdin) {
  if (stdin.isTTY) throw new UsageError('--literals-stdin reads the values from a pipe; nothing was piped in');
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const c of stdin) {
    size += c.length;
    if (size > MAX_LITERALS_BYTES) throw new UsageError('more than 1 MiB of literals on stdin');
    chunks.push(/** @type {Buffer} */ (c));
  }
  const literals = [];
  for (const [i, raw] of Buffer.concat(chunks).toString('utf8').split('\n').entries()) {
    const line = raw.replace(/\r$/, '');
    if (line === '') continue;
    if (line.length < MIN_LITERAL_LENGTH) throw new UsageError(`stdin line ${i + 1}: literals must be at least ${MIN_LITERAL_LENGTH} characters (shorter ones match ordinary text)`);
    literals.push(line);
  }
  if (literals.length === 0) throw new UsageError('--literals-stdin: no values on stdin');
  return literals;
}

/** @param {string} p */
const shownPath = (p) => p.replace(/[\u0000-\u001f\u007f]/g, '?');

/**
 * @param {string[]} argv
 * @param {{cwd?: string, stdin?: NodeJS.ReadableStream & {isTTY?: boolean}, out?: (line: string) => void, note?: (line: string) => void}} [io]
 */
export async function main(argv, { cwd = process.cwd(), stdin = process.stdin, out = (l) => process.stdout.write(`${l}\n`), note = (l) => process.stderr.write(`${l}\n`) } = {}) {
  let literalsFromStdin = false;
  for (const a of argv) {
    if (a === '--literals-stdin') literalsFromStdin = true;
    else if (a === '-h' || a === '--help') {
      out('usage: node scripts/scan-secrets.mjs [--literals-stdin]   (values one per line on stdin, never as arguments)');
      return EXIT.CLEAN;
    } else throw new UsageError(/^--?[a-z-]{1,24}$/.test(a) ? `unknown option ${a}` : 'unexpected argument (values are read from stdin with --literals-stdin, never from arguments)');
  }
  const forms = literalForms(literalsFromStdin ? await readLiterals(stdin) : []);
  const counts = { worktree: 0, history: 0, messages: 0 };
  let findings = 0;
  /** @param {keyof typeof counts} kind @param {string} location @param {string} file @param {number} line @param {string} rule */
  const report = (kind, location, file, line, rule) => {
    counts[kind]++;
    findings++;
    out(`${location}:${file}:${line} ${rule}`);
  };
  /** A path that itself matches is reported and never printed. @param {keyof typeof counts} kind @param {string} location @param {string} p */
  const displayPath = (kind, location, p) => {
    const hits = scanText(p, forms);
    if (hits.length === 0) return shownPath(p);
    for (const [, rule] of hits) report(kind, location, '[redacted path]', 0, rule);
    return '[redacted path]';
  };
  /** @param {keyof typeof counts} kind @param {string} location @param {string} shown @param {Buffer | null} content */
  const scanContent = (kind, location, shown, content) => {
    if (content === null) return report(kind, location, shown, 0, 'unscanned-large-file');
    if (isArchive(content)) report(kind, location, shown, 0, 'unscanned-archive'); // its raw bytes are still searched below
    for (const [line, rule] of scanText(content.toString('latin1'), forms)) report(kind, location, shown, line, rule);
  };

  let top = null;
  try {
    top = (await git(cwd, ['rev-parse', '--show-toplevel'])).toString('utf8').trim();
  } catch (err) {
    let dir = path.resolve(cwd);
    for (;;) {
      if (existsSync(path.join(dir, '.git'))) throw err; // a repository git cannot read: never skip its history silently
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  let files = 0;
  if (top === null) {
    note('note: not a git work tree; scanned the files on disk only (top-level .gitignore applied), no history');
    for (const rel of await walk(cwd)) {
      const full = path.join(cwd, rel);
      const st = await lstat(full);
      files++;
      const shown = displayPath('worktree', 'worktree', rel);
      if (st.isSymbolicLink()) scanContent('worktree', 'worktree', shown, await readlink(full, { encoding: 'buffer' }));
      else scanContent('worktree', 'worktree', shown, st.size > MAX_FILE_BYTES ? null : await readFile(full));
    }
    out(`scan: ${findings} finding${findings === 1 ? '' : 's'} (worktree ${counts.worktree}); ${files} files scanned, no git history`);
    return findings ? EXIT.FINDINGS : EXIT.CLEAN;
  }

  // Working tree: every entry git lists (tracked and untracked, not ignored). The path of each is
  // scanned, also for symlinks, gitlinks and files deleted from disk; the content of regular files
  // and the target of symlinks (never followed).
  for (const rel of [...new Set((await git(top, ['ls-files', '-z', '-co', '--exclude-standard'])).toString('utf8').split('\0').filter(Boolean))]) {
    const full = path.join(top, rel);
    files++;
    const shown = displayPath('worktree', 'worktree', rel);
    const st = await lstat(full).catch(() => null);
    if (st?.isFile()) scanContent('worktree', 'worktree', shown, st.size > MAX_FILE_BYTES ? null : await readFile(full));
    else if (st?.isSymbolicLink()) scanContent('worktree', 'worktree', shown, await readlink(full, { encoding: 'buffer' }));
  }

  // History: every path of every commit once (at the oldest commit with it), and each distinct
  // blob once (at the oldest commit and path where it appears).
  const short = (/** @type {string} */ id) => id.slice(0, 12);
  const commits = (await git(top, ['rev-list', '--all', '--reverse'])).toString('utf8').split('\n').filter(Boolean);
  /** @type {Map<string, {location: string, path: string}>} */
  const blobs = new Map();
  /** @type {Map<string, string>} path -> oldest commit */
  const paths = new Map();
  const commitTrees = new Set();
  for (const commit of commits) {
    let tree;
    try {
      tree = (await git(top, ['ls-tree', '-r', '-t', '-z', '--full-tree', commit])).toString('utf8').split('\0');
    } catch {
      report('history', short(commit), '(tree)', 0, 'unscanned-missing-object');
      continue;
    }
    for (const entry of tree) {
      const tab = entry.indexOf('\t');
      if (tab === -1) continue;
      const [, type, id] = entry.slice(0, tab).split(' ');
      const p = entry.slice(tab + 1);
      if (type === 'tree') {
        commitTrees.add(id);
        continue;
      }
      if (!paths.has(p)) paths.set(p, commit);
      if (type === 'blob' && !blobs.has(id)) blobs.set(id, { location: short(commit), path: p });
    }
  }
  /** @type {Map<string, string>} path -> as shown */
  const shownPaths = new Map();
  for (const [p, commit] of paths) shownPaths.set(p, displayPath('history', short(commit), p));

  // Every object reachable from any ref, also blobs and trees a ref or tag points to directly and
  // tags only another tag reaches. Missing objects are reported, never fetched.
  /** @type {Map<string, string>} id -> name rev-list gives it ('' for none) */
  const objects = new Map();
  /** @type {Set<string>} */
  const missing = new Set();
  for (const line of (await git(top, ['rev-list', '--objects', '--all', '--missing=print'])).toString('utf8').split('\n')) {
    const m = /^(\?)?([0-9a-f]{40,64})(?: (.*))?$/.exec(line);
    if (m && m[1]) missing.add(m[2]);
    else if (m && !objects.has(m[2])) objects.set(m[2], m[3] ?? '');
  }
  /** @type {Map<string, string>} */
  const types = new Map();
  for (const line of (await gitWithInput(top, ['cat-file', '--batch-check'], [...objects.keys()].map((id) => `${id}\n`).join(''))).toString('latin1').split('\n')) {
    const [id, type] = line.split(' ');
    if (type === 'missing') missing.add(id);
    else if (id && type) types.set(id, type);
  }
  const ofType = (/** @type {string} */ t) => [...types].filter(([, type]) => type === t).map(([id]) => id);
  // Objects outside every commit's tree are reported under their own id and rev-list's name for them.
  for (const id of [...ofType('blob'), ...ofType('tree')]) {
    const name = /** @type {string} */ (objects.get(id));
    if (blobs.has(id) || commitTrees.has(id) || name === '') continue;
    const shown = shownPaths.get(name) ?? displayPath('history', short(id), name);
    shownPaths.set(name, shown);
    if (types.get(id) === 'blob') blobs.set(id, { location: short(id), path: name });
  }
  const where = (/** @type {string} */ id) => {
    const w = blobs.get(id);
    return w ? { location: w.location, shown: /** @type {string} */ (shownPaths.get(w.path)) } : { location: short(id), shown: '(object)' };
  };
  const reportMissing = (/** @type {string} */ id) => {
    const w = where(id);
    report('history', w.location, w.shown, 0, 'unscanned-missing-object');
  };
  for (const id of missing) reportMissing(id);

  const blobIds = ofType('blob');
  let blobsRead = 0;
  await catFile(
    top,
    blobIds,
    (id, _type, content) => {
      blobsRead++;
      const w = where(id);
      scanContent('history', w.location, w.shown, content);
    },
    reportMissing,
  );
  // Commit and tag objects: headers (author, committer, signature) and message, separately numbered.
  const tags = ofType('tag');
  await catFile(
    top,
    [...commits, ...tags],
    (id, type, content) => {
      if (content === null) return report('messages', short(id), `(${type})`, 0, 'unscanned-large-file');
      const text = content.toString('latin1');
      const split = text.indexOf('\n\n');
      const head = split === -1 ? text : text.slice(0, split);
      const message = split === -1 ? '' : text.slice(split + 2);
      for (const [line, rule] of scanText(head, forms)) report('messages', short(id), `(${type} header)`, line, rule);
      for (const [line, rule] of scanText(message, forms)) report('messages', short(id), type === 'tag' ? '(tag message)' : '(message)', line, rule);
    },
    (id) => report('messages', short(id), '(object)', 0, 'unscanned-missing-object'),
  );
  out(
    `scan: ${findings} finding${findings === 1 ? '' : 's'} (worktree ${counts.worktree}, history ${counts.history}, commit and tag objects ${counts.messages}); ` +
      `${files} files, ${blobsRead} blobs, ${commits.length} commits, ${tags.length} tags scanned`,
  );
  return findings ? EXIT.FINDINGS : EXIT.CLEAN;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`scan-secrets: ${err instanceof UsageError ? err.message : `unexpected ${err?.name ?? 'error'}`}\n`);
      process.exitCode = EXIT.USAGE;
    },
  );
}
