// Version (from package.json) and short commit (from VERCEL_GIT_COMMIT_SHA).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** @type {string} */
export const VERSION = require('../package.json').version;

/**
 * @param {string | undefined} sha
 * @returns {string | null} first 7 hex characters, or null when absent/invalid
 */
export function shortCommit(sha) {
  return typeof sha === 'string' && /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 7).toLowerCase() : null;
}
