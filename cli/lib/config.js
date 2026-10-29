// Config storage: ${XDG_CONFIG_HOME:-~/.config}/michael-router/ (0700) holding config.json {url}
// and credentials (the router password), both 0600. Files are written atomically: a new file is
// created exclusively with its final mode next to the target, then renamed over it, so a reader
// never sees a partial file and an existing (possibly too permissive) file or symlink is replaced,
// never written through.
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CliError } from './errors.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_FILE_BYTES = 64 * 1024;

/**
 * @typedef {{dir: string, config: string, credentials: string, adminCredentials: string}} Paths
 */

/** @param {Record<string, string | undefined>} env @returns {Paths} */
export function configPaths(env) {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(env.HOME || os.homedir(), '.config');
  const dir = path.join(base, 'michael-router');
  return { dir, config: path.join(dir, 'config.json'), credentials: path.join(dir, 'credentials'), adminCredentials: path.join(dir, 'admin-credentials') };
}

/** Router passwords travel in a header: printable ASCII without leading or trailing spaces. @param {string} p */
export const passwordShapeOk = (p) => /^[\x20-\x7e]+$/.test(p) && p === p.trim();

/** @param {unknown} err @param {string} code */
const isCode = (err, code) => /** @type {NodeJS.ErrnoException} */ (err)?.code === code;

/**
 * Read a small regular file without following a symlink.
 * @param {string} file
 * @returns {Promise<{text: string, mode: number} | null>} null when missing
 */
async function readSmallFile(file) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if (isCode(err, 'ENOENT')) return null;
    if (isCode(err, 'ELOOP')) throw new CliError(`${file} is a symbolic link; refusing to read it`);
    throw new CliError(`cannot read ${file} (${/** @type {NodeJS.ErrnoException} */ (err).code ?? 'error'})`);
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new CliError(`${file} is not a regular file`);
    if (st.size > MAX_FILE_BYTES) throw new CliError(`${file} is too large`);
    return { text: await handle.readFile('utf8'), mode: st.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

/** @param {Paths} paths @returns {Promise<{url?: string}>} */
export async function readConfig(paths) {
  const file = await readSmallFile(paths.config);
  if (!file) return {};
  try {
    const o = JSON.parse(file.text);
    if (o && typeof o === 'object' && !Array.isArray(o)) return typeof o.url === 'string' ? { url: o.url } : {};
  } catch {
    // fall through
  }
  throw new CliError(`${paths.config} is not a valid config file; fix or delete it`);
}

/**
 * The stored router password, or null. Warns (never fails) when the file is accessible by group
 * or others.
 * @param {Paths} paths
 * @param {(message: string) => void} warn
 * @returns {Promise<string | null>}
 */
export async function readCredentials(paths, warn) {
  const file = await readSmallFile(paths.credentials);
  if (!file) return null;
  if (file.mode & 0o077) {
    warn(`${paths.credentials} is accessible by other users (mode ${file.mode.toString(8).padStart(4, '0')}); run: chmod 600 '${paths.credentials}'`);
  }
  const password = file.text.replace(/\r?\n$/, '');
  return password === '' ? null : password;
}

/** Create the config dir (0700) or tighten an existing one. @param {Paths} paths */
async function ensureDir(paths) {
  await mkdir(paths.dir, { recursive: true, mode: DIR_MODE });
  const st = await lstat(paths.dir);
  if (!st.isDirectory()) throw new CliError(`${paths.dir} is not a directory`);
  if ((st.mode & 0o777) !== DIR_MODE) await chmod(paths.dir, DIR_MODE);
}

/**
 * Write `data` to `file` atomically with mode 0600: exclusive create of a temp file in the same
 * directory (with the final mode), write, fsync, rename over the target.
 * @param {Paths} paths
 * @param {string} file
 * @param {string} data
 */
export async function atomicWrite(paths, file, data) {
  await ensureDir(paths);
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
    await handle.chmod(FILE_MODE); // the umask can only remove bits; this makes the mode exact
    await handle.writeFile(data, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmp, file);
  } catch (err) {
    await handle?.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    if (err instanceof CliError) throw err;
    throw new CliError(`cannot write ${file} (${/** @type {NodeJS.ErrnoException} */ (err).code ?? 'error'})`);
  }
}

/** @param {Paths} paths @param {{url: string}} config */
export const writeConfig = (paths, config) => atomicWrite(paths, paths.config, `${JSON.stringify({ url: config.url }, null, 2)}\n`);

/** @param {Paths} paths @param {string} password */
export const writeCredentials = (paths, password) => atomicWrite(paths, paths.credentials, password);

/** @param {Paths} paths @returns {Promise<boolean>} whether a file was removed */
export async function deleteCredentials(paths) {
  try {
    await unlink(paths.credentials);
    return true;
  } catch (err) {
    if (isCode(err, 'ENOENT')) return false;
    throw new CliError(`cannot delete ${paths.credentials} (${/** @type {NodeJS.ErrnoException} */ (err).code ?? 'error'})`);
  }
}

/** @param {string} file @returns {Promise<number | null>} permission bits, or null when missing */
export async function fileMode(file) {
  try {
    return (await lstat(file)).mode & 0o777;
  } catch {
    return null;
  }
}

export const readAdminCredentials = (paths, warn) => readCredentials({ ...paths, credentials: paths.adminCredentials }, warn);
export const writeAdminCredentials = (paths, password) => atomicWrite(paths, paths.adminCredentials, password);
export const deleteAdminCredentials = (paths) => deleteCredentials({ ...paths, credentials: paths.adminCredentials });
