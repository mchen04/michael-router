// Entry point logic: parse, build the per-run context, dispatch, print help, and turn errors into
// one-line messages and exit codes. Error messages and everything printed through ctx.print /
// ctx.printJson pass through a scrubber holding the secrets of this run (password, provider
// key), as a last line of defence. Streamed model output is written as received.
import { VERSION } from '../../src/version.js';
import { GLOBAL_FLAGS, helpHint, parseArgv } from './args.js';
import { COMMANDS } from './commands.js';
import { configPaths, passwordShapeOk, readConfig, readCredentials } from './config.js';
import { CliError, EXIT, usageError } from './errors.js';
import { clean, createClient, normalizeUrl } from './http.js';
import { colorEnabled, palette } from './output.js';
import { readSecret } from './prompt.js';

/**
 * @typedef {import('./commands.js').Command} Command
 * @typedef {{stdin: import('./prompt.js').Input, stdout: NodeJS.WritableStream & {isTTY?: boolean},
 *   stderr: NodeJS.WritableStream & {isTTY?: boolean}, env: Record<string, string | undefined>}} IO
 * @typedef {ReturnType<typeof createContext>} Context
 */

/**
 * Replace every registered secret, raw or JSON-escaped, with [redacted].
 * @param {Set<string>} secrets
 * @returns {(text: string) => string}
 */
function scrubber(secrets) {
  return (text) => {
    let t = text;
    for (const s of secrets) {
      if (!s) continue;
      for (const form of new Set([s, JSON.stringify(s).slice(1, -1)])) t = t.split(form).join('[redacted]');
    }
    return t;
  };
}

/**
 * @param {import('./args.js').Parsed} parsed
 * @param {IO} io
 * @param {Set<string>} secrets
 */
function createContext(parsed, io, secrets) {
  const scrub = scrubber(secrets);
  const { flags, positionals, path } = parsed;
  const { env } = io;
  const paths = configPaths(env);
  const timeoutS = parseTimeout(flags.timeout);
  /** @type {Promise<{url?: string}> | undefined} */
  let configPromise;

  const ctx = {
    flags,
    positionals,
    path,
    env,
    paths,
    stdin: io.stdin,
    stdout: io.stdout,
    stderr: io.stderr,
    json: Boolean(flags.json),
    c: palette(colorEnabled(io.stdout, flags, env)),
    ce: palette(colorEnabled(io.stderr, flags, env)),
    /** @type {string | undefined} the router URL once a client exists */
    url: undefined,
    now: () => Date.now(),
    /** @param {string} text */
    print: (text) => io.stdout.write(scrub(text)),
    /** @param {unknown} value */
    printJson: (value) => io.stdout.write(scrub(`${JSON.stringify(value, null, 2)}\n`)),
    /** @param {string} text */
    warn: (text) => io.stderr.write(`mrouter: warning: ${text}\n`),
    /** Register a secret for scrubbing and return it. @param {string} value */
    secret(value) {
      secrets.add(value);
      return value;
    },
    config: () => (configPromise ??= readConfig(paths)),
    /** @param {number} defaultS */
    timeoutMs: (defaultS) => Math.round((timeoutS ?? defaultS) * 1000),
    /** @param {string} label @param {string} what @param {{confirm?: boolean}} [options] */
    readSecret: (label, what, options = {}) => readSecret({ label, what, stdin: io.stdin, stderr: io.stderr, confirm: options.confirm }),

    /**
     * --url, then MROUTER_URL, then config.json (null only when not required).
     * @param {{required?: boolean}} [options]
     * @returns {Promise<any>} {url, source} or null
     */
    async resolveUrl({ required = true } = {}) {
      /** @type {{url: string, source: string} | null} */
      let found = null;
      if (typeof flags.url === 'string') found = { url: normalizeUrl(flags.url), source: '--url' };
      else if (env.MROUTER_URL) found = { url: normalizeUrl(env.MROUTER_URL), source: 'MROUTER_URL' };
      else {
        const config = await ctx.config();
        if (config.url) found = { url: normalizeUrl(config.url), source: 'config.json' };
      }
      if (!found && required) throw usageError("no router URL: pass --url, set MROUTER_URL or run 'mrouter login --url URL'");
      return found;
    },

    /**
     * The router password: MROUTER_PASSWORD, else the stored one, which is only sent to the URL it
     * was saved for.
     * @param {string} url
     */
    async password(url) {
      if (env.MROUTER_PASSWORD) {
        const p = ctx.secret(env.MROUTER_PASSWORD);
        if (!passwordShapeOk(p)) throw usageError('MROUTER_PASSWORD must be printable ASCII without leading or trailing spaces');
        return p;
      }
      const stored = await readCredentials(paths, ctx.warn);
      if (stored === null) throw usageError("no router password: run 'mrouter login' or set MROUTER_PASSWORD");
      ctx.secret(stored);
      if (!passwordShapeOk(stored)) {
        throw usageError(
          `the stored password in ${paths.credentials} is malformed: it must be one line of printable ASCII without leading or trailing spaces`,
          "run 'mrouter login' again",
        );
      }
      const config = await ctx.config();
      let savedFor = null;
      try {
        savedFor = config.url ? normalizeUrl(config.url) : null;
      } catch {
        // an unusable saved URL matches nothing
      }
      if (savedFor !== url) {
        throw usageError(
          `the stored password was saved for ${savedFor ?? 'another URL'} and is only sent there`,
          `run 'mrouter login --url ${url}' or set MROUTER_PASSWORD`,
        );
      }
      return stored;
    },

    /** An authenticated client. @param {number} defaultTimeoutS */
    async client(defaultTimeoutS) {
      const { url } = await ctx.resolveUrl();
      const password = await ctx.password(url);
      ctx.url = url;
      return createClient({ url, password, timeoutMs: ctx.timeoutMs(defaultTimeoutS) });
    },
  };
  return ctx;
}

/** @param {string | boolean | undefined} raw @returns {number | undefined} seconds */
function parseTimeout(raw) {
  if (raw === undefined) return undefined;
  const s = typeof raw === 'string' && /^\d{1,4}(\.\d{1,3})?$/.test(raw) ? Number(raw) : NaN;
  if (!(s >= 0.1 && s <= 3600)) throw usageError('--timeout must be a number of seconds from 0.1 to 3600');
  return s;
}

/** @param {Record<string, import('./args.js').FlagSpec>} flags */
function flagLines(flags) {
  const entries = Object.entries(flags).map(([key, spec]) => {
    const names = `${spec.short ? `-${spec.short}, ` : ''}--${key}${spec.value ? ` ${spec.value}` : ''}`;
    return [names, spec.help];
  });
  const w = Math.max(...entries.map(([n]) => n.length));
  return entries.map(([n, h]) => `  ${n.padEnd(w)}  ${h}`).join('\n');
}

function topHelp() {
  /** @type {[string, string][]} */
  const rows = [];
  for (const cmd of Object.values(COMMANDS)) {
    for (const c of cmd.subcommands ? Object.values(cmd.subcommands) : [cmd]) rows.push([c.synopsis ?? c.usage.split(' [')[0], c.summary]);
  }
  const w = Math.max(...rows.map(([u]) => u.length));
  return [
    'mrouter: command-line client for Michael Router',
    '',
    'Usage: mrouter [global flags] <command> [flags] [arguments]',
    '',
    'Commands:',
    ...rows.map(([u, s]) => `  ${u.padEnd(w)}  ${s}`),
    '',
    'Global flags:',
    flagLines(GLOBAL_FLAGS),
    '',
    'Environment: MROUTER_URL, MROUTER_PASSWORD (used instead of the stored password), NO_COLOR,',
    'XDG_CONFIG_HOME (config in $XDG_CONFIG_HOME/michael-router, default ~/.config/michael-router).',
    '',
    'Exit codes: 0 ok, 1 error, 2 usage, 3 router auth/limit, 4 upstream/provider error, 5 network.',
    'Secrets (router password, provider keys) are read from a hidden prompt or stdin, never from arguments.',
    "Run 'mrouter <command> --help' for details.",
    '',
  ].join('\n');
}

/** @param {string[]} path @param {Command} cmd */
function commandHelp(path, cmd) {
  const out = [`Usage: mrouter ${cmd.usage}`, '', cmd.description ?? cmd.summary];
  if (cmd.subcommands) {
    out.push('', 'Subcommands:');
    const subs = Object.values(cmd.subcommands);
    const w = Math.max(...subs.map((s) => s.usage.length));
    for (const s of subs) out.push(`  ${s.usage.padEnd(w)}  ${s.summary}`);
  }
  if (cmd.flags && Object.keys(cmd.flags).length) out.push('', 'Flags:', flagLines(cmd.flags));
  out.push('', 'Global flags: --url URL, --json, --timeout S, --no-color, -h/--help');
  if (cmd.examples?.length) out.push('', 'Examples:', ...cmd.examples.map((e) => `  ${e}`));
  out.push('');
  return out.join('\n');
}

/** @param {string[]} words */
function findCommand(words) {
  /** @type {Command | undefined} */
  let node;
  /** @type {Record<string, Command> | undefined} */
  let table = COMMANDS;
  for (const w of words) {
    node = table && Object.hasOwn(table, w) ? table[w] : undefined;
    if (!node) throw usageError(`no help for that command`, helpHint([]));
    table = node.subcommands;
  }
  return node;
}

/**
 * Run the CLI. Never throws; resolves to the exit code.
 * @param {string[]} argv
 * @param {IO} io
 * @returns {Promise<number>}
 */
export async function main(argv, io) {
  /** @type {Set<string>} */
  const secrets = new Set();
  const scrub = scrubber(secrets);
  // Pre-scanned, so that --no-color also applies when the arguments do not parse.
  const end = argv.indexOf('--');
  const noColor = (end === -1 ? argv : argv.slice(0, end)).includes('--no-color');
  const errStyle = palette(colorEnabled(io.stderr, { 'no-color': noColor }, io.env));
  try {
    const parsed = parseArgv(argv, COMMANDS);
    if (parsed.help) {
      io.stdout.write(parsed.path.length ? commandHelp(parsed.path, /** @type {Command} */ (parsed.node)) : topHelp());
      return EXIT.OK;
    }
    if (parsed.flags.version) {
      io.stdout.write(`mrouter ${VERSION}\n`);
      return EXIT.OK;
    }
    if (parsed.path.length === 0) {
      io.stdout.write(topHelp());
      return EXIT.OK;
    }
    if (parsed.path[0] === 'help') {
      const cmd = findCommand(parsed.positionals);
      io.stdout.write(cmd ? commandHelp(parsed.positionals, cmd) : topHelp());
      return EXIT.OK;
    }
    const cmd = /** @type {Command} */ (parsed.node);
    if (!cmd.run) {
      throw usageError(`${parsed.path.join(' ')} needs a subcommand: ${Object.keys(cmd.subcommands ?? {}).join(', ')}`, helpHint(parsed.path));
    }
    const ctx = createContext(parsed, io, secrets);
    await cmd.run(ctx);
    return EXIT.OK;
  } catch (err) {
    if (err instanceof CliError) {
      if (err.exitCode === EXIT.INTERRUPTED) {
        io.stderr.write('mrouter: cancelled\n');
      } else {
        io.stderr.write(`${errStyle.red('mrouter:')} ${scrub(err.message)}${err.hint ? ` (${scrub(err.hint)})` : ''}\n`);
      }
      return err.exitCode;
    }
    io.stderr.write(`${errStyle.red('mrouter:')} internal error: ${scrub(clean(/** @type {Error} */ (err)?.message ?? err))}\n`);
    return EXIT.ERROR;
  }
}
