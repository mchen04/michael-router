#!/usr/bin/env node
// Deterministic secret transfer to Vercel environment variables (DESIGN §10).
//
//   node scripts/copy-keys-to-vercel.mjs --manifest <path> [--environment production] [--check | --yes]
//
// The manifest names, for each Vercel environment variable, exactly one source; entries are
// handled in manifest order. Modes:
//   (default)  print the plan (env name <- source name, plan digest) and exit; nothing is read.
//   --check    read and validate every source; no `vercel` command except `env ls`.
//   --yes      read, validate and transfer each value with `vercel env add <NAME> production --force
//              --sensitive`, the value written to the child's stdin. A Vercel CLI without --sensitive
//              stops the run first. onlyIfAbsent entries are sent without --force: when Vercel
//              answers that the name already exists, the entry is skipped, never overwritten.
// Every failure stops the run at once (no fallback source, no retry, no further entries):
//   STOPPED at <ENV> (source <type:name>): <scrubbed reason>
// Exit codes: 0 done, 1 unexpected error, 2 usage or invalid manifest, 3 stopped or final check failed.
//
// Values never reach argv, a child's environment, logs, temporary files or error messages. Child
// processes get an allowlisted environment only; their output is never printed, only a scrubbed
// first error line when they fail.
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { constants as FS, realpathSync, statSync } from 'node:fs';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashPassword, parsePasswordHash } from '../src/auth.js';
import { MIN_PASSWORD_LENGTH, providerKeyProblem } from '../src/config.js';
import { scrub } from '../src/redact.js';

export const EXIT = Object.freeze({ OK: 0, ERROR: 1, USAGE: 2, STOPPED: 3 });

/** The only variables a manifest may set, and how each value is checked. */
const NAMES = Object.freeze({
  ANTHROPIC_API_KEY: 'provider-key',
  GEMINI_API_KEY: 'provider-key',
  OPENROUTER_API_KEY: 'provider-key',
  ROUTER_PASSWORD_HASH: 'password-hash',
  ROUTER_PASSWORD: 'password',
  ROUTER_SECRET: 'secret',
  UPSTASH_REDIS_REST_URL: 'store-url',
  UPSTASH_REDIS_REST_TOKEN: 'store-token',
});
const STORE_PAIRS = [
  ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
  ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
];
/** The only environment variables passed to `vercel`, `security` and `op` (when set). */
const CHILD_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID', 'OP_ACCOUNT'];
/** Production only: Preview needs a git-branch answer and Development cannot hold sensitive values. */
const ENVIRONMENTS = ['production'];
const SHELL_RC_FILES = new Set([
  '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.zshrc', '.zshenv', '.zprofile', '.zlogin',
  '.zlogout', '.cshrc', '.tcshrc', '.kshrc', '.login', '.logout', '.envrc', 'config.fish',
]);
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ENTRIES = Object.keys(NAMES).length;
const MAX_VALUE_BYTES = 4096;
const MAX_SOURCE_FILE_BYTES = 1024 * 1024;
const MAX_STDIN_BYTES = 64 * 1024;
const MAX_CHILD_OUTPUT = 1024 * 1024;
const CHILD_TIMEOUT_MS = 180_000;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

class UsageError extends Error {}

/** Control characters out of anything echoed from the manifest or a child. @param {string} s */
const printable = (s) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');

// ------------------------------------------------------------------ manifest

/**
 * @typedef {{type: 'keychain', service: string, account: string} | {type: 'file', path: string, var: string} |
 *   {type: 'op', ref: string} | {type: 'stdin'} | {type: 'generate', bytes: number}} Source
 * @typedef {{env: keyof typeof NAMES, source: Source, transform: 'scrypt-hash' | null, onlyIfAbsent: boolean, file?: string}} Entry
 * @typedef {{version: 1, environment: string, entries: Entry[]}} Manifest
 */

/** @param {unknown} v */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {Record<string, unknown>} o @param {string[]} required @param {string[]} optional @param {string} where
 */
function exactKeys(o, required, optional, where) {
  for (const k of Object.keys(o)) {
    if (!required.includes(k) && !optional.includes(k)) throw new UsageError(`${where}: unknown key${/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k) && scrub(k) === k ? ` "${k}"` : ''}`);
  }
  for (const k of required) if (!(k in o)) throw new UsageError(`${where}: "${k}" is required`);
}

/** @param {unknown} v @param {number} max */
const shortText = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

/** `$HOME` and the account's home from the user database, which a changed `$HOME` does not hide. @param {string} home */
function homes(home) {
  const all = new Set([home]);
  try {
    const passwd = os.userInfo().homedir;
    if (passwd && path.isAbsolute(passwd)) all.add(passwd);
  } catch {
    // no user database entry: $HOME only
  }
  return [...all];
}

/**
 * A descriptor the scrubber would change holds key-shaped text (a value pasted where a source
 * name belongs): refused without echoing it. Paths and op:// references are checked per
 * `/`-separated segment, because a long ordinary path would look like a token as a whole.
 * @param {string} v @param {string} what @param {string} where @param {boolean} [segments]
 */
function refuseSecretShaped(v, what, where, segments = false) {
  if ((segments ? v.split('/') : [v]).some((part) => scrub(part) !== part)) {
    throw new UsageError(`${where}: ${what} looks like a secret (key-shaped text), not a source name`);
  }
}

/** Paths under these roots are refused for `file` sources (agent and tool homes, temp dirs, /etc). */
export function prohibitedRoots(home = os.homedir()) {
  const roots = homes(home).flatMap((h) => ['.hermes', '.claude', '.codex', '.cache'].map((d) => path.join(h, d)));
  roots.push('/tmp', '/private', '/var/folders', '/etc');
  for (const t of [process.env.TMPDIR, os.tmpdir()]) if (t && path.isAbsolute(t)) roots.push(path.resolve(t));
  const all = new Set(roots);
  for (const r of roots) {
    try {
      all.add(realpathSync(r));
    } catch {
      // a root that does not exist cannot contain the file
    }
  }
  return [...all];
}

/**
 * Device and inode of every existing root, so that a root is recognized under any other name
 * (an APFS firmlink such as /System/Volumes/Data/private, a bind mount, a case or Unicode variant).
 * @param {string[]} roots @returns {Map<string, string>} "dev:ino" -> root
 */
function rootIdentities(roots) {
  const ids = new Map();
  for (const r of roots) {
    try {
      const st = statSync(r);
      const id = `${st.dev}:${st.ino}`;
      if (!ids.has(id)) ids.set(id, r);
    } catch {
      // a root that does not exist cannot contain the file
    }
  }
  return ids;
}

const foldCase = process.platform === 'darwin' || process.platform === 'win32';
/** @param {string} p */
const fold = (p) => (foldCase ? p.toLowerCase() : p);

/**
 * Why an absolute, resolved path may not be a source, or null.
 * @param {string} p @param {string[]} roots
 */
export function pathProblem(p, roots) {
  const fp = fold(p);
  for (const r of roots) {
    const fr = fold(r);
    if (fp === fr || fp.startsWith(fr.endsWith(path.sep) ? fr : fr + path.sep)) return `the path is under the prohibited root ${r}`;
  }
  if (SHELL_RC_FILES.has(path.basename(fp))) return 'shell rc files are never read';
  return null;
}

/** Expand a leading `~/`; anything else must already be absolute. @param {string} p @param {string} home */
function expandPath(p, home) {
  if (p.startsWith('~/')) return path.resolve(home, p.slice(2));
  if (!path.isAbsolute(p)) return null;
  return path.resolve(p);
}

/**
 * @param {unknown} raw @param {string} where @param {string} home @param {string[]} roots
 * @returns {Source & {file?: string}}
 */
function parseSource(raw, where, home, roots) {
  if (!isObject(raw)) throw new UsageError(`${where}: "source" must be an object`);
  const s = /** @type {Record<string, any>} */ (raw);
  switch (s.type) {
    case 'keychain':
      exactKeys(s, ['type', 'service', 'account'], [], where);
      for (const k of ['service', 'account']) {
        if (!shortText(s[k], 256) || s[k].startsWith('-')) throw new UsageError(`${where}: keychain "${k}" must be a name (1-256 characters, not starting with "-")`);
        refuseSecretShaped(s[k], `keychain "${k}"`, where);
      }
      return { type: 'keychain', service: s.service, account: s.account };
    case 'file': {
      exactKeys(s, ['type', 'path', 'var'], [], where);
      if (!shortText(s.path, 1024)) throw new UsageError(`${where}: file "path" must be a non-empty path`);
      if (typeof s.var !== 'string' || !NAME_RE.test(s.var) || s.var.length > 128) throw new UsageError(`${where}: file "var" must be a variable name`);
      refuseSecretShaped(s.path, 'file "path"', where, true);
      refuseSecretShaped(s.var, 'file "var"', where);
      const file = expandPath(s.path, home);
      if (!file) throw new UsageError(`${where}: file "path" must be absolute (or start with ~/)`);
      const problem = pathProblem(file, roots);
      if (problem) throw new UsageError(`${where}: ${problem}`);
      return { type: 'file', path: s.path, var: s.var, file };
    }
    case 'op':
      exactKeys(s, ['type', 'ref'], [], where);
      if (!shortText(s.ref, 512) || !s.ref.startsWith('op://')) throw new UsageError(`${where}: op "ref" must be an op:// reference`);
      refuseSecretShaped(s.ref, 'op "ref"', where, true);
      return { type: 'op', ref: s.ref };
    case 'stdin':
      exactKeys(s, ['type'], [], where);
      return { type: 'stdin' };
    case 'generate':
      exactKeys(s, ['type', 'bytes'], [], where);
      if (!Number.isInteger(s.bytes) || s.bytes < 32 || s.bytes > 64) throw new UsageError(`${where}: generate "bytes" must be an integer from 32 to 64`);
      return { type: 'generate', bytes: s.bytes };
    default:
      throw new UsageError(`${where}: source "type" must be one of keychain, file, op, stdin, generate`);
  }
}

/**
 * Validate a parsed manifest. Unknown keys anywhere, unknown or repeated names, a second stdin
 * entry and prohibited file paths are refused.
 * @param {unknown} raw @param {{home?: string, environment?: string}} [options]
 * @returns {Manifest}
 */
export function validateManifest(raw, { home = os.homedir(), environment } = {}) {
  if (!isObject(raw)) throw new UsageError('manifest: must be a JSON object');
  const m = /** @type {Record<string, any>} */ (raw);
  exactKeys(m, ['version', 'environment', 'entries'], [], 'manifest');
  if (m.version !== 1) throw new UsageError('manifest: "version" must be 1');
  if (!ENVIRONMENTS.includes(m.environment)) throw new UsageError(`manifest: "environment" must be ${ENVIRONMENTS.map((e) => `"${e}"`).join(' or ')}`);
  if (environment !== undefined && environment !== m.environment) throw new UsageError(`--environment ${printable(environment)} does not match the manifest's "${m.environment}"`);
  if (!Array.isArray(m.entries) || m.entries.length === 0 || m.entries.length > MAX_ENTRIES) {
    throw new UsageError(`manifest: "entries" must be an array of 1 to ${MAX_ENTRIES} entries`);
  }
  const roots = prohibitedRoots(home);
  const seen = new Set();
  /** @type {Entry[]} */
  const entries = [];
  m.entries.forEach((/** @type {unknown} */ e, /** @type {number} */ i) => {
    let where = `entries[${i}]`;
    if (!isObject(e)) throw new UsageError(`${where}: must be an object`);
    const o = /** @type {Record<string, any>} */ (e);
    if (typeof o.env !== 'string' || !Object.hasOwn(NAMES, o.env)) {
      throw new UsageError(`${where}: "env" must be one of ${Object.keys(NAMES).join(', ')}`);
    }
    where += ` (${o.env})`;
    exactKeys(o, ['env', 'source'], ['transform', 'onlyIfAbsent'], where);
    if (seen.has(o.env)) throw new UsageError(`${where}: ${o.env} appears more than once`);
    seen.add(o.env);
    if (o.transform !== undefined && o.transform !== 'scrypt-hash') throw new UsageError(`${where}: "transform" must be "scrypt-hash"`);
    if (o.transform === 'scrypt-hash' && o.env !== 'ROUTER_PASSWORD_HASH') throw new UsageError(`${where}: "scrypt-hash" applies to ROUTER_PASSWORD_HASH only`);
    if (o.onlyIfAbsent !== undefined && typeof o.onlyIfAbsent !== 'boolean') throw new UsageError(`${where}: "onlyIfAbsent" must be true or false`);
    const source = parseSource(o.source, where, home, roots);
    if (source.type === 'generate' && (o.env !== 'ROUTER_SECRET' || o.onlyIfAbsent !== true)) {
      throw new UsageError(`${where}: "generate" is for ROUTER_SECRET with "onlyIfAbsent": true only`);
    }
    entries.push({ env: o.env, source, transform: o.transform ?? null, onlyIfAbsent: o.onlyIfAbsent === true });
  });
  if (entries.filter((e) => e.source.type === 'stdin').length > 1) throw new UsageError('manifest: at most one entry may read stdin');
  if (seen.has('ROUTER_PASSWORD_HASH') && seen.has('ROUTER_PASSWORD')) {
    throw new UsageError('manifest: set ROUTER_PASSWORD_HASH or ROUTER_PASSWORD, not both (the router refuses to start with both)');
  }
  if (seen.has('UPSTASH_REDIS_REST_URL') !== seen.has('UPSTASH_REDIS_REST_TOKEN')) {
    throw new UsageError('manifest: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN go together');
  }
  return { version: 1, environment: m.environment, entries };
}

/** Deterministic JSON: object keys sorted, no whitespace. @param {unknown} v @returns {string} */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObject(v)) {
    const o = /** @type {Record<string, unknown>} */ (v);
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** SHA-256 over the canonical names and source descriptors (never values). @param {Manifest} m */
export function planDigest(m) {
  const plan = {
    version: m.version,
    environment: m.environment,
    entries: m.entries.map(({ env, source, transform, onlyIfAbsent }) => {
      const { file: _resolved, ...descriptor } = /** @type {Source & {file?: string}} */ (source);
      return { env, source: descriptor, transform, onlyIfAbsent };
    }),
  };
  return createHash('sha256').update(canonical(plan)).digest('hex');
}

/** @param {Source} s */
function sourceName(s) {
  switch (s.type) {
    case 'keychain':
      return printable(`keychain:${s.service}/${s.account}`);
    case 'file':
      return printable(`file:${s.path}#${s.var}`);
    case 'op':
      return printable(`op:${s.ref}`);
    case 'generate':
      return `generate:${s.bytes}`;
    default:
      return 'stdin';
  }
}

// ------------------------------------------------------------------ child processes

function childEnv() {
  /** @type {Record<string, string>} */
  const env = {};
  for (const name of CHILD_ENV) {
    const v = process.env[name];
    if (typeof v === 'string' && v !== '') env[name] = v;
  }
  return env;
}

/**
 * @typedef {{ok: boolean, code: number | null, failure: string | null, stdout: Buffer, stderr: Buffer}} ChildResult
 */

/**
 * Run a command with the allowlisted environment, no shell, optional stdin bytes.
 * @param {string} command @param {string[]} args @param {Buffer} [input]
 * @returns {Promise<ChildResult>}
 */
function runChild(command, args, input) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    const size = { out: 0, err: 0 };
    let settled = false;
    let timedOut = false;
    /** @param {number | null} code @param {string | null} failure */
    const finish = (code, failure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(out);
      for (const c of out) c.fill(0);
      resolve({ ok: failure === null && code === 0, code, failure, stdout, stderr: Buffer.concat(err) });
    };
    const child = spawn(command, args, { env: childEnv(), stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], shell: false });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CHILD_TIMEOUT_MS);
    child.stdout?.on('data', (/** @type {Buffer} */ c) => {
      if (size.out < MAX_CHILD_OUTPUT) out.push(c);
      size.out += c.length;
    });
    child.stderr?.on('data', (/** @type {Buffer} */ c) => {
      if (size.err < MAX_CHILD_OUTPUT) err.push(c);
      size.err += c.length;
    });
    child.on('error', (e) => {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      finish(null, code === 'ENOENT' ? `${command}: command not found on PATH` : `${command} could not be started (${code ?? 'error'})`);
    });
    child.on('close', (code, signal) => {
      finish(code, timedOut ? `${command} timed out after ${CHILD_TIMEOUT_MS / 1000} s` : signal ? `${command} was killed (${signal})` : null);
    });
    if (input && child.stdin) {
      child.stdin.on('error', () => {}); // a child that exits early closes its stdin
      child.stdin.end(input);
    }
  });
}

/** A child's stderr and stdout without terminal escapes. @param {ChildResult} r */
const childText = (r) => `${r.stderr.toString('utf8')}\n${r.stdout.toString('utf8')}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
/** How `vercel env add` without --force refuses a name that exists. */
const ALREADY_EXISTS = /\balready (?:been added|exists)\b/i;

/**
 * The line that explains a failed child: the first line mentioning an error, else the first line
 * that is not a version banner; scrubbed of the values and of key-shaped text.
 * @param {ChildResult} r @param {string} command @param {string[]} values
 */
function failureLine(r, command, values) {
  if (r.failure) return r.failure;
  const lines = childText(r)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^Vercel CLI \d/.test(l));
  const line = lines.find((l) => /\berror\b/i.test(l)) ?? lines[0] ?? `${command} exited with code ${r.code}`;
  return printable(scrub(line, values.filter((v) => v.length >= 4))).slice(0, 300);
}

/** Trim one trailing newline (\n or \r\n) in place (returns a view). @param {Buffer} b */
function trimNewline(b) {
  let end = b.length;
  if (end > 0 && b[end - 1] === 0x0a) end--;
  if (end > 0 && b[end - 1] === 0x0d && end < b.length) end--;
  return b.subarray(0, end);
}

// ------------------------------------------------------------------ sources

/** One variable from a dotenv file: no expansion, no evaluation, quotes stripped. @param {string} text @param {string} name */
export function dotenvValue(text, name) {
  let count = 0;
  /** @type {string | null} */
  let value = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || m[1] !== name) continue;
    count++;
    value = unquote(m[2]);
  }
  if (count === 0) return { problem: `${name} is not set in the file` };
  if (count > 1) return { problem: `${name} is set more than once in the file` };
  if (value === null) return { problem: `${name} has a malformed quoted value` };
  return { value };
}

/** @param {string} v @returns {string | null} */
function unquote(v) {
  const q = v[0];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, 1);
    if (end === -1) return null;
    const rest = v.slice(end + 1).trim();
    return rest === '' || rest.startsWith('#') ? v.slice(1, end) : null;
  }
  const comment = v.search(/\s#/);
  return (comment === -1 ? v : v.slice(0, comment)).trim();
}

/**
 * @param {string} file @param {string} name @param {{roots: string[], ids: Map<string, string>}} policy
 * @returns {Promise<{value: Buffer} | {problem: string}>}
 */
async function readFileSource(file, name, { roots, ids }) {
  let real;
  try {
    real = await realpath(file);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    return { problem: code === 'ENOENT' ? 'the file does not exist' : `the file cannot be resolved (${code})` };
  }
  const problem = pathProblem(real, roots);
  if (problem) return { problem: `the file resolves to a refused location: ${problem}` };
  let handle;
  /** @type {Buffer | null} */
  let content = null;
  try {
    handle = await open(real, FS.O_RDONLY | FS.O_NOFOLLOW);
    const st = await handle.stat();
    if (!st.isFile()) return { problem: 'the path is not a regular file' };
    // A second hard link could sit under a prohibited root; realpath cannot tell.
    if (st.nlink !== 1) return { problem: 'the file has more than one hard link' };
    const now = await stat(real);
    if (now.dev !== st.dev || now.ino !== st.ino) return { problem: 'the file changed while it was opened' };
    for (let dir = path.dirname(real); ; dir = path.dirname(dir)) {
      const d = await stat(dir);
      const root = ids.get(`${d.dev}:${d.ino}`);
      if (root) return { problem: `the file resolves to a refused location: the path is under the prohibited root ${root}` };
      if (path.dirname(dir) === dir) break;
    }
    if (st.size > MAX_SOURCE_FILE_BYTES) return { problem: 'the file is larger than 1 MiB' };
    content = await readFile(handle);
    const r = dotenvValue(content.toString('utf8'), name);
    return 'problem' in r ? r : { value: Buffer.from(/** @type {string} */ (r.value), 'utf8') };
  } catch (err) {
    return { problem: `the file cannot be read (${/** @type {NodeJS.ErrnoException} */ (err).code ?? 'error'})` };
  } finally {
    content?.fill(0);
    await handle?.close();
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return { problem: 'stdin is a terminal; pipe the value in (it is never typed)' };
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const c of process.stdin) {
    size += c.length;
    if (size > MAX_STDIN_BYTES) {
      for (const x of chunks) x.fill(0);
      c.fill(0);
      return { problem: 'stdin holds more than 64 KiB' };
    }
    chunks.push(c);
  }
  const all = Buffer.concat(chunks);
  for (const x of chunks) x.fill(0);
  return { value: all };
}

/**
 * @param {Entry} entry @param {{roots: string[], ids: Map<string, string>}} policy
 * @returns {Promise<{value: Buffer} | {problem: string}>} the raw value (one trailing newline removed)
 */
async function readSource(entry, policy) {
  const s = entry.source;
  if (s.type === 'generate') return { value: Buffer.from(randomBytes(s.bytes).toString('base64url'), 'latin1') };
  if (s.type === 'file') return readFileSource(/** @type {string} */ (entry.source.file), s.var, policy);
  if (s.type === 'stdin') {
    const r = await readStdin();
    return 'value' in r ? { value: trimNewline(r.value) } : r;
  }
  const [command, args] =
    s.type === 'keychain' ? ['security', ['find-generic-password', '-s', s.service, '-a', s.account, '-w']] : ['op', ['read', s.ref]];
  const r = await runChild(command, args);
  if (!r.ok) {
    r.stdout.fill(0);
    return { problem: failureLine({ ...r, stdout: Buffer.alloc(0) }, command, []) };
  }
  return { value: trimNewline(r.stdout) };
}

/**
 * Why a value may not be uploaded, or null. Messages never include the value or its length.
 * @param {Entry} entry @param {Buffer} value
 */
export function valueProblem(entry, value) {
  if (value.length === 0) return 'the value is empty';
  if (value.length > MAX_VALUE_BYTES) return `the value is longer than ${MAX_VALUE_BYTES} bytes`;
  for (const b of value) if (b < 0x21 || b > 0x7e) return 'the value contains whitespace, control or non-ASCII characters';
  const text = value.toString('latin1');
  switch (NAMES[entry.env]) {
    case 'provider-key':
      return providerKeyProblem(text);
    case 'password':
      return text.length < MIN_PASSWORD_LENGTH ? `the password must be at least ${MIN_PASSWORD_LENGTH} characters long` : null;
    case 'password-hash':
      if (entry.transform === 'scrypt-hash') return text.length < MIN_PASSWORD_LENGTH ? `the password must be at least ${MIN_PASSWORD_LENGTH} characters long` : null;
      return parsePasswordHash(text) ? null : 'the value is not a valid scrypt$ hash (use "transform": "scrypt-hash" for a password)';
    case 'secret':
      return /^[A-Za-z0-9+/_-]+={0,2}$/.test(text) && Buffer.from(text, 'base64').length >= 32 ? null : 'ROUTER_SECRET must be at least 32 bytes, base64 or base64url';
    case 'store-url': {
      let url;
      try {
        url = new URL(text);
      } catch {
        return 'the store URL is not a valid URL';
      }
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash ? null : 'the store URL must be https:// without credentials, query or fragment';
    }
    default:
      return text.length < 8 ? 'the store token is too short' : null;
  }
}

// ------------------------------------------------------------------ vercel

/** Variable names in `vercel env ls` output (first column); the output itself is never printed. @param {ChildResult} r */
function envNames(r) {
  const names = new Set();
  for (const line of `${r.stdout.toString('utf8')}\n${r.stderr.toString('utf8')}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/)) {
    const first = line.trim().split(/\s+/)[0];
    if (/^[A-Z_][A-Z0-9_]+$/.test(first)) names.add(first);
  }
  return names;
}

/** @param {string} environment */
async function listEnv(environment) {
  const r = await runChild('vercel', ['env', 'ls', environment]);
  return r.ok ? { names: envNames(r) } : { problem: failureLine(r, 'vercel', []) };
}

/** @param {Set<string>} names */
const bothPasswords = (names) => names.has('ROUTER_PASSWORD_HASH') && names.has('ROUTER_PASSWORD');

// ------------------------------------------------------------------ main

const USAGE = `usage: node scripts/copy-keys-to-vercel.mjs --manifest <path> [--environment production] [--check | --yes]

Without --check or --yes the plan is printed and nothing is read or transferred.
  --check   read and validate every source; transfer nothing
  --yes     transfer each value to Vercel in manifest order, stopping at the first failure
See docs/DEPLOY.md and scripts/key-sources.example.json.`;

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{manifest?: string, environment?: string, check: boolean, yes: boolean, help: boolean}} */
  const o = { check: false, yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const [flag, inline] = a.startsWith('--') && eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, undefined];
    if (flag === '--manifest' || flag === '--environment') {
      const v = inline ?? argv[++i];
      if (v === undefined || v === '') throw new UsageError(`${flag} needs a value`);
      o[flag === '--manifest' ? 'manifest' : 'environment'] = v;
    } else if (a === '--check') o.check = true;
    else if (a === '--yes') o.yes = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new UsageError(a.startsWith('-') && /^--?[a-z-]{1,24}$/.test(flag) ? `unknown option ${flag}` : 'unexpected argument (values are never accepted as arguments)');
  }
  if (!o.help && !o.manifest) throw new UsageError('--manifest is required');
  if (o.check && o.yes) throw new UsageError('use --check or --yes, not both');
  return o;
}

/** @param {string} line */
const say = (line) => process.stdout.write(`${line}\n`);

/** @param {string} where @param {string} reason */
function stop(where, reason) {
  say(`STOPPED at ${where}: ${reason}`);
  return EXIT.STOPPED;
}

/** @param {Entry} e */
const stopAt = (e) => `${e.env} (source ${sourceName(e.source)})`;

/** @param {Manifest} m */
function printPlan(m) {
  say(`Plan: ${m.entries.length} entr${m.entries.length === 1 ? 'y' : 'ies'} for Vercel environment "${m.environment}", in this order:`);
  const width = Math.max(...m.entries.map((e) => e.env.length));
  m.entries.forEach((e, i) => {
    const notes = [e.transform, e.onlyIfAbsent ? 'only if absent' : null].filter(Boolean);
    say(`  ${i + 1}. ${e.env.padEnd(width)} <- ${sourceName(e.source)}${notes.length ? ` (${notes.join(', ')})` : ''}`);
  });
  say(`Plan digest: sha256:${planDigest(m)}`);
}

/** @param {Set<string>} names @param {Manifest} m */
function finalReport(names, m) {
  const known = [...Object.keys(NAMES), 'KV_REST_API_URL', 'KV_REST_API_TOKEN'];
  const present = known.filter((n) => names.has(n));
  say(`Present in Vercel ${m.environment} (names only): ${present.length ? present.join(', ') : 'none'}`);
  const pairs = STORE_PAIRS.filter(([u, t]) => names.has(u) && names.has(t));
  if (pairs.length === 0) say('Store: no complete store pair; protected routes answer 503 until a store is connected (docs/DEPLOY.md).');
  else if (pairs.length === 2) say('Store: both KV_REST_API_* and UPSTASH_REDIS_REST_* are present; the router uses KV_REST_API_*.');
  else say(`Store: ${pairs[0].join(' and ')} present.`);
  if (bothPasswords(names)) {
    return stop('final check', `ROUTER_PASSWORD_HASH and ROUTER_PASSWORD both exist in ${m.environment}; the router refuses to start with both (503). Remove one with "vercel env rm <NAME> ${m.environment}".`);
  }
  const missing = m.entries.map((e) => e.env).filter((n) => !names.has(n));
  if (missing.length) return stop('final check', `not present after the transfer: ${missing.join(', ')}`);
  say('Done: every manifest name is present.');
  return EXIT.OK;
}

/** @param {string[]} argv */
export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    say(USAGE);
    return EXIT.OK;
  }
  const manifestPath = /** @type {string} */ (opts.manifest);
  let text;
  try {
    const buf = await readFile(manifestPath);
    if (buf.length > MAX_MANIFEST_BYTES) throw new UsageError('manifest: larger than 64 KiB');
    text = buf.toString('utf8');
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new UsageError(`cannot read the manifest (${/** @type {NodeJS.ErrnoException} */ (err).code ?? 'error'})`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new UsageError('manifest: not valid JSON');
  }
  const home = os.homedir();
  const m = validateManifest(raw, { home, environment: opts.environment });
  printPlan(m);
  if (!opts.check && !opts.yes) {
    say('Dry run: nothing was read or transferred. Use --check to validate every source, --yes to transfer.');
    return EXIT.OK;
  }

  if (opts.yes) {
    // Every managed variable is a secret: without --sensitive nothing is transferred.
    const help = await runChild('vercel', ['env', 'add', '--help']);
    if (help.failure) return stop('vercel env add --help', help.failure);
    if (!/--sensitive\b/.test(`${help.stdout}${help.stderr}`)) {
      return stop('vercel env add --help', 'this Vercel CLI does not offer --sensitive; every managed variable is a secret, so nothing was read or transferred. Update the Vercel CLI and run again.');
    }
  }
  const before = await listEnv(m.environment);
  if ('problem' in before) return stop(`vercel env ls ${m.environment}`, /** @type {string} */ (before.problem));
  const existing = /** @type {Set<string>} */ (before.names);
  const sets = new Set(m.entries.map((e) => e.env));
  const after = new Set([...existing, ...sets]);
  if (bothPasswords(after)) {
    const mine = ['ROUTER_PASSWORD_HASH', 'ROUTER_PASSWORD'].find((p) => sets.has(p));
    const other = mine === 'ROUTER_PASSWORD' ? 'ROUTER_PASSWORD_HASH' : 'ROUTER_PASSWORD';
    const what = mine ? `the manifest sets ${mine} but ${other} already exists in ${m.environment}` : `ROUTER_PASSWORD_HASH and ROUTER_PASSWORD both exist in ${m.environment}`;
    return stop('pre-check', `${what}; the router refuses to start with both (503). Remove one first with "vercel env rm ${mine ? other : '<NAME>'} ${m.environment}".`);
  }

  const roots = prohibitedRoots(home);
  const policy = { roots, ids: rootIdentities(roots) };
  /** Names that `vercel env add` (without --force) reported as already existing. */
  const confirmed = new Set();
  const n = m.entries.length;
  for (const [i, entry] of m.entries.entries()) {
    const tag = `[${i + 1}/${n}] ${entry.env}`;
    if (entry.onlyIfAbsent && existing.has(entry.env)) {
      say(`${tag}: ${opts.check ? 'would skip' : 'skipped'} (already present in ${m.environment})`);
      continue;
    }
    if (opts.check && entry.source.type === 'generate') {
      say(`${tag}: ok (generated at transfer time)`);
      continue;
    }
    const read = await readSource(entry, policy);
    if ('problem' in read) return stop(stopAt(entry), read.problem);
    let value = read.value;
    const problem = valueProblem(entry, value);
    if (problem) {
      value.fill(0);
      return stop(stopAt(entry), problem);
    }
    if (entry.transform === 'scrypt-hash') {
      const hash = Buffer.from(await hashPassword(value.toString('latin1')), 'latin1');
      value.fill(0);
      value = hash;
    }
    if (opts.check) {
      value.fill(0);
      say(`${tag}: ok`);
      continue;
    }
    // onlyIfAbsent never overwrites: without --force, Vercel itself refuses an existing name,
    // even one that `env ls` did not show.
    const args = ['env', 'add', entry.env, m.environment, ...(entry.onlyIfAbsent ? [] : ['--force']), '--sensitive'];
    const r = await runChild('vercel', args, value);
    const scrubValues = [value.toString('latin1')];
    value.fill(0);
    if (!r.ok && !r.failure && entry.onlyIfAbsent && ALREADY_EXISTS.test(childText(r))) {
      confirmed.add(entry.env);
      say(`${tag}: skipped (already exists in ${m.environment})`);
      continue;
    }
    if (!r.ok) return stop(stopAt(entry), failureLine(r, 'vercel', scrubValues));
    say(`${tag}: set (sensitive)`);
  }
  if (opts.check) {
    say(`Check passed: ${n} entr${n === 1 ? 'y' : 'ies'}; nothing was transferred.`);
    return EXIT.OK;
  }
  const final = await listEnv(m.environment);
  if ('problem' in final) return stop(`vercel env ls ${m.environment}`, /** @type {string} */ (final.problem));
  return finalReport(new Set([.../** @type {Set<string>} */ (final.names), ...confirmed]), m);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      if (err instanceof UsageError) {
        process.stderr.write(`copy-keys-to-vercel: ${err.message}\n${err.message.startsWith('manifest') || err.message.startsWith('entries') ? '' : `${USAGE}\n`}`);
        process.exitCode = EXIT.USAGE;
      } else {
        process.stderr.write(`copy-keys-to-vercel: unexpected ${/** @type {Error} */ (err)?.name ?? 'error'}\n`);
        process.exitCode = EXIT.ERROR;
      }
    },
  );
}
