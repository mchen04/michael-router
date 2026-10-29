// Spawn dev/server.js as a real process on port 0.
// Children get an explicit, minimal environment (nothing is inherited from the test runner);
// provider base URLs default to a closed port unless the test points them at a fake.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { ADMIN_PASSWORD, OFFLINE_BASE_URLS, passwordHash } from './fixtures.js';

export const DEV_SERVER = fileURLToPath(new URL('../../dev/server.js', import.meta.url));

/**
 * @param {string} script
 * @param {string[]} args
 * @param {Record<string, string>} env
 */
export async function startProcess(script, args = [], env = {}) {
  const child = spawn(process.execPath, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out starting ${script}: ${stderr}`)), 15000);
    child.stdout.on('data', (d) => {
      stdout += d;
      const m = /listening on (http:\/\/\S+)/.exec(stdout);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${script} exited with ${code}: ${stderr}`));
    });
  });
  return {
    url: /** @type {string} */ (url),
    child,
    output: () => ({ stdout, stderr }),
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      await once(child, 'exit');
    },
  };
}

/** @param {Record<string, string>} env @param {string[]} [flags] */
export const startDevServer = async (env, flags = []) => startProcess(DEV_SERVER, ['--port', '0', ...flags], { ...OFFLINE_BASE_URLS, ROUTER_ADMIN_PASSWORD_HASH: await passwordHash(ADMIN_PASSWORD), ...env });
