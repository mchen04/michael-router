// Fake `vercel`, `security` and `op` executables for the deployment-script tests.
// Each fake is a small wrapper in <root>/bin that calls runFake() with its directories baked in:
// the scripts under test give children an allowlisted environment, so a fake cannot be
// configured through environment variables. The call log (<root>/log/calls.jsonl) records argv,
// the SHA-256 and length of stdin and the environment variable *names* — never a value.
// Fake behavior and source values live in <root>/fake (config.json, captured.json, state.json).
// Fake `vercel`: `present` names are listed by `env ls`, `hidden` names exist but are not listed;
// `env add` without --force refuses an existing name, as the real CLI does.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HELPER = fileURLToPath(import.meta.url);
export const REPO = fileURLToPath(new URL('../..', import.meta.url));
/** Gitignored scratch space inside the checkout (system temp dirs are prohibited source roots). */
const SCRATCH = path.join(REPO, 'tmp');

/**
 * @typedef {string | {exit: number, stderr: string}} FakeSecret a value, or a refusal
 * @typedef {{
 *   keychain?: Record<string, FakeSecret>,
 *   op?: Record<string, FakeSecret>,
 *   vercel?: {present?: string[], hidden?: string[], sensitive?: boolean, refuse?: Record<string, string>, capture?: string[], dropAdds?: boolean},
 * }} FakeConfig
 * @typedef {{tool: string, argv: string[], stdin_sha256: string, stdin_bytes: number, env: string[]}} FakeCall
 */

/** A fresh test root under the checkout's gitignored tmp/ directory. @param {string} prefix */
export async function makeScratchRoot(prefix) {
  await mkdir(SCRATCH, { recursive: true });
  const root = await mkdtemp(path.join(SCRATCH, `${prefix}-`));
  return {
    root,
    async remove() {
      await rm(root, { recursive: true, force: true });
      await rmdir(SCRATCH).catch(() => {}); // only when empty
    },
  };
}

/** @param {string} root */
export async function createFakeTools(root) {
  const bin = path.join(root, 'bin');
  const state = path.join(root, 'fake');
  const log = path.join(root, 'log');
  await Promise.all([bin, state, log].map((d) => mkdir(d, { recursive: true })));
  for (const tool of ['vercel', 'security', 'op']) {
    const body = `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(HELPER).href)}).then((m) => m.runFake(${JSON.stringify(tool)}, ${JSON.stringify(state)}, ${JSON.stringify(log)}));\n`;
    await writeFile(path.join(bin, tool), body, { mode: 0o755 });
  }
  return {
    bin,
    state,
    log,
    /** @param {FakeConfig} config */
    async configure(config) {
      await writeFile(path.join(state, 'config.json'), JSON.stringify(config));
      await rm(path.join(state, 'state.json'), { force: true });
      await rm(path.join(state, 'captured.json'), { force: true });
      await rm(path.join(log, 'calls.jsonl'), { force: true });
    },
    /** @returns {Promise<FakeCall[]>} */
    async calls() {
      const text = await readFile(path.join(log, 'calls.jsonl'), 'utf8').catch(() => '');
      return text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    },
    /** Values the fake vercel captured for the names in `vercel.capture`. @returns {Promise<Record<string, string>>} */
    async captured() {
      return JSON.parse(await readFile(path.join(state, 'captured.json'), 'utf8').catch(() => '{}'));
    },
  };
}

/** @param {string} file @param {any} fallback */
async function readJson(file, fallback) {
  return JSON.parse(await readFile(file, 'utf8').catch(() => JSON.stringify(fallback)));
}

/** @param {string} out @param {string} err @param {number} code */
function exit(out, err, code) {
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  process.exitCode = code;
}

/** @param {FakeSecret | undefined} entry @param {string} missing */
function secret(entry, missing) {
  if (typeof entry === 'string') return exit(`${entry}\n`, '', 0);
  if (entry) return exit('', `${entry.stderr}\n`, entry.exit);
  return exit('', `${missing}\n`, 1);
}

/** Entry point of every fake. @param {string} tool @param {string} stateDir @param {string} logDir */
export async function runFake(tool, stateDir, logDir) {
  const argv = process.argv.slice(2);
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const input = Buffer.concat(chunks);
  /** @type {FakeCall} */
  const call = {
    tool,
    argv,
    stdin_sha256: createHash('sha256').update(input).digest('hex'),
    stdin_bytes: input.length,
    env: Object.keys(process.env).sort(),
  };
  await appendFile(path.join(logDir, 'calls.jsonl'), `${JSON.stringify(call)}\n`);
  /** @type {FakeConfig} */
  const config = await readJson(path.join(stateDir, 'config.json'), {});

  if (tool === 'security') {
    const [cmd, s, service, a, account, w] = argv;
    if (cmd !== 'find-generic-password' || s !== '-s' || a !== '-a' || w !== '-w' || argv.length !== 6) return exit('', 'security: bad arguments\n', 2);
    return secret(config.keychain?.[`${service}/${account}`], 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.');
  }
  if (tool === 'op') {
    if (argv[0] !== 'read' || argv.length !== 2) return exit('', '[ERROR] bad arguments\n', 2);
    return secret(config.op?.[argv[1]], `[ERROR] could not read secret '${argv[1]}': item not found`);
  }

  const v = config.vercel ?? {};
  const banner = 'Vercel CLI 99.0.0 (fake)\n';
  const statePath = path.join(stateDir, 'state.json');
  /** @type {{added: string[]}} */
  const state = await readJson(statePath, { added: [] });
  const [group, sub, name, environment, ...flags] = argv;
  if (group !== 'env') return exit('', `${banner}Error: unexpected fake vercel call\n`, 9);
  if (sub === 'add' && name === '--help') {
    const options = ['--force   Overwrite an existing variable', ...(v.sensitive === false ? [] : ['--sensitive   Mark the variable as sensitive'])];
    return exit('', `${banner}  vercel env add <name> [environment]\n\n  Options:\n${options.map((o) => `    ${o}\n`).join('')}`, 2);
  }
  if (sub === 'ls' && argv.length === 3) {
    const names = [...new Set([...(v.present ?? []), ...state.added])];
    const rows = names.map((n) => ` ${n.padEnd(28)} Encrypted   ${name}   1d ago   RAW-LS-OUTPUT\n`).join('');
    return exit(` name                         value       environments   created\n${rows}`, `${banner}> Environment Variables found for fake/project [5ms]\n`, 0);
  }
  if (sub === 'add' && new Set(flags).size === flags.length && flags.every((f) => f === '--force' || f === '--sensitive')) {
    const refusal = v.refuse?.[name];
    if (refusal !== undefined) return exit('', `${banner}Error: ${refusal.replace('{value}', input.toString('utf8'))}\n`, 1);
    const exists = [...(v.present ?? []), ...(v.hidden ?? []), ...state.added].includes(name);
    if (exists && !flags.includes('--force')) {
      return exit('', `${banner}Error: The variable "${name}" has already been added to all Environments. To remove, run \`vercel env rm ${name}\`.\n`, 1);
    }
    if (v.capture?.includes(name)) {
      const capturedPath = path.join(stateDir, 'captured.json');
      const captured = await readJson(capturedPath, {});
      captured[name] = input.toString('utf8');
      await writeFile(capturedPath, JSON.stringify(captured));
    }
    if (!v.dropAdds) await writeFile(statePath, JSON.stringify({ added: [...state.added, name] }));
    return exit(`Added Environment Variable ${name} to Project fake [10ms]\n`, banner, 0);
  }
  return exit('', `${banner}Error: unexpected fake vercel call\n`, 9);
}
