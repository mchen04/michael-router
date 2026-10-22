// Spawn dev/server.js and dev/fake-upstash.js as real processes on port 0.
// Children get an explicit, minimal environment (nothing is inherited from the test runner);
// provider base URLs default to a closed port unless the test points them at a fake.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { OFFLINE_BASE_URLS } from './fixtures.js';

export const DEV_SERVER = fileURLToPath(new URL('../../dev/server.js', import.meta.url));
export const FAKE_UPSTASH = fileURLToPath(new URL('../../dev/fake-upstash.js', import.meta.url));

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
export const startDevServer = (env, flags = []) => startProcess(DEV_SERVER, ['--port', '0', ...flags], { ...OFFLINE_BASE_URLS, ...env });

/** @param {string} token @param {string[]} [flags] */
export const startFakeUpstash = (token, flags = []) => startProcess(FAKE_UPSTASH, ['--port', '0', '--token', token, ...flags]);

/** Send one raw command to a fake Upstash. @param {string} url @param {string} token @param {unknown[]} cmd */
export async function upstash(url, token, cmd) {
  const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(cmd) });
  return res.json();
}
