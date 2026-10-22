// Command-line parsing: global flags anywhere, command and subcommand words, per-command flags,
// `--flag value` / `--flag=value` / `-x value`, and `--` to end flags. Error messages never echo a
// token that does not look like a flag or command name (it might be a pasted secret).
import { usageError } from './errors.js';

/**
 * @typedef {{type: 'boolean' | 'string', short?: string, value?: string, help: string}} FlagSpec
 * @typedef {{summary?: string, flags?: Record<string, FlagSpec>, subcommands?: Record<string, CommandNode>}} CommandNode
 * @typedef {{path: string[], node: CommandNode, flags: Record<string, string | boolean>, positionals: string[], help: boolean}} Parsed
 */

/** @type {Record<string, FlagSpec>} */
export const GLOBAL_FLAGS = Object.freeze({
  url: { type: 'string', value: 'URL', help: 'Router URL (default: $MROUTER_URL, then the URL saved by login)' },
  json: { type: 'boolean', help: 'Print machine-readable JSON on stdout' },
  timeout: { type: 'string', value: 'S', help: 'Request timeout in seconds (default 30; ask and test: 300)' },
  'no-color': { type: 'boolean', help: 'No colors (also NO_COLOR; colors are only used on a terminal)' },
  help: { type: 'boolean', short: 'h', help: 'Show help' },
  version: { type: 'boolean', help: 'Print the version' },
});

const SAFE_LONG_FLAG = /^--[a-z][a-z0-9-]{0,23}$/;
const SAFE_SHORT_FLAG = /^-[A-Za-z]$/;
const SAFE_WORD = /^[a-z][a-z0-9-]{0,23}$/;

/** @param {string} name */
const shownFlag = (name) => (SAFE_LONG_FLAG.test(name) || SAFE_SHORT_FLAG.test(name) ? ` ${name}` : '');
/** @param {string[]} path */
export const helpHint = (path) => `see 'mrouter${path.length ? ` ${path.join(' ')}` : ''} --help'`;

/**
 * @param {string} name `--long` or `-x`
 * @param {CommandNode} node
 * @returns {[string, FlagSpec] | null}
 */
function findFlag(name, node) {
  const tables = [GLOBAL_FLAGS, node.flags ?? {}];
  for (const table of tables) {
    for (const [key, spec] of Object.entries(table)) {
      if (name === `--${key}` || (spec.short && name === `-${spec.short}`)) return [key, spec];
    }
  }
  return null;
}

/**
 * @param {string[]} argv
 * @param {Record<string, CommandNode>} commands
 * @returns {Parsed}
 */
export function parseArgv(argv, commands) {
  /** @type {CommandNode} */
  let node = { subcommands: commands };
  /** @type {string[]} */
  const path = [];
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  /** @type {string[]} */
  const positionals = [];
  let rest = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!rest && token === '--') {
      rest = true;
      continue;
    }
    if (!rest && token.length > 1 && token.startsWith('-')) {
      const eq = token.startsWith('--') ? token.indexOf('=') : -1;
      const name = eq === -1 ? token : token.slice(0, eq);
      const inline = eq === -1 ? undefined : token.slice(eq + 1);
      const found = findFlag(name, node);
      if (!found) throw usageError(`unknown flag${shownFlag(name)}`, helpHint(path));
      const [key, spec] = found;
      if (spec.type === 'boolean') {
        if (inline !== undefined) throw usageError(`${name} takes no value`, helpHint(path));
        flags[key] = true;
        if (key === 'help') return { path, node, flags, positionals, help: true };
      } else {
        const value = inline ?? argv[++i];
        if (value === undefined) throw usageError(`${name} needs a value`, helpHint(path));
        flags[key] = value;
      }
      continue;
    }
    if (node.subcommands) {
      const child = Object.hasOwn(node.subcommands, token) ? node.subcommands[token] : null;
      if (!child) {
        const what = path.length ? `${path.join(' ')} subcommand` : 'command';
        throw usageError(`unknown ${what}${SAFE_WORD.test(token) ? ` "${token}"` : ''}`, helpHint(path));
      }
      node = child;
      path.push(token);
      continue;
    }
    positionals.push(token);
  }
  return { path, node, flags, positionals, help: false };
}

/**
 * A positive integer flag in [min, max], or undefined when absent.
 * @param {string | boolean | undefined} value @param {string} name @param {number} min @param {number} max
 */
export function intFlag(value, name, min, max) {
  if (value === undefined) return undefined;
  const n = typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : NaN;
  if (!(n >= min && n <= max)) throw usageError(`--${name} must be an integer from ${min} to ${max}`);
  return n;
}
