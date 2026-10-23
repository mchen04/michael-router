// Strict dotenv documents and bounded stdin, shared by the operator scripts that take secrets
// (scripts/migrate.mjs and scripts/copy-keys-to-vercel.mjs).
//
// A document is `NAME=value` lines (optionally `export NAME=value`), blank lines and `#` comment
// lines. A value is either unquoted (trimmed; ` #` starts a comment) or wholly inside single or
// double quotes, taken literally (no escapes, no expansion, no evaluation) and optionally followed
// by a comment. Any other line, a malformed quoted value or a name set twice makes the whole
// document invalid: nothing is guessed. Problems name a line number or a variable, never a value.
import { Buffer } from 'node:buffer';

export const MAX_STDIN_BYTES = 64 * 1024;
const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** @param {string} v @returns {string | null} null when a quoted value is malformed */
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
 * @param {string} text
 * @returns {{vars: Map<string, string>} | {problem: string}}
 */
export function parseEnvDocument(text) {
  /** @type {Map<string, string>} */
  const vars = new Map();
  const lines = text.split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = ASSIGNMENT.exec(line);
    if (!m) return { problem: `line ${i + 1} is not a NAME=value line` };
    const value = unquote(m[2]);
    if (value === null) return { problem: `${m[1]} (line ${i + 1}) has a malformed quoted value` };
    if (vars.has(m[1])) return { problem: `${m[1]} is set more than once` };
    vars.set(m[1], value);
  }
  return { vars };
}

/**
 * One variable of a document.
 * @param {string} text @param {string} name @param {string} where how the document is named in a problem
 * @returns {{value: string} | {problem: string}}
 */
export function envValue(text, name, where) {
  const doc = parseEnvDocument(text);
  if ('problem' in doc) return { problem: `${where}: ${doc.problem}` };
  const value = doc.vars.get(name);
  return value === undefined ? { problem: `${name} is not set in ${where}` } : { value };
}

/**
 * All of stdin, refused when it is a terminal (a secret is piped in, never typed) or larger than
 * `maxBytes`. Chunks are zero-filled once copied.
 * @param {NodeJS.ReadableStream & {isTTY?: boolean}} [stream] @param {number} [maxBytes]
 * @returns {Promise<{value: Buffer} | {problem: string}>}
 */
export async function readStdin(stream = process.stdin, maxBytes = MAX_STDIN_BYTES) {
  if (stream.isTTY) return { problem: 'stdin is a terminal; pipe the value in (it is never typed)' };
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const c = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += c.length;
    if (size > maxBytes) {
      for (const x of chunks) x.fill(0);
      c.fill(0);
      return { problem: `stdin holds more than ${maxBytes / 1024} KiB` };
    }
    chunks.push(c);
  }
  const all = Buffer.concat(chunks);
  for (const x of chunks) x.fill(0);
  return { value: all };
}
