// Secret scrubber used by events and logs: configured values (provider keys, ROUTER_SECRET,
// store token, password hash, the presented bearer) and well-known secret patterns.

export const REDACTED = '[redacted]';
const MIN_VALUE_LENGTH = 4; // shorter "secrets" would mangle ordinary text without protecting anything

/** @type {[RegExp, string | ((m: string) => string)][]} */
const PATTERNS = [
  [/\bBearer\s+[^\s"',;]+/gi, `Bearer ${REDACTED}`],
  [/sk-ant-[A-Za-z0-9_-]{4,}/g, REDACTED],
  [/sk-or-[A-Za-z0-9_-]{4,}/g, REDACTED],
  [/AIza[0-9A-Za-z_-]{20,}/g, REDACTED],
  [/\b[0-9a-fA-F]{32,}\b/g, REDACTED],
  // long base64/base64url runs that look like random tokens (digits, lower and upper case);
  // lowercase model ids and paths are left alone, hex tokens are caught above
  [/[A-Za-z0-9+/_-]{40,}={0,2}/g, (m) => (/\d/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m) ? REDACTED : m)],
];

/** @param {unknown[]} values @returns {string[]} unique, longest first */
function normalize(values) {
  const set = new Set(values.filter((v) => typeof v === 'string' && v.length >= MIN_VALUE_LENGTH));
  return [.../** @type {Set<string>} */ (set)].sort((a, b) => b.length - a.length);
}

/**
 * @param {unknown} text
 * @param {string[]} [values] literal secrets to replace first
 * @returns {string}
 */
export function scrub(text, values = []) {
  let out = typeof text === 'string' ? text : String(text ?? '');
  for (const v of values) if (out.includes(v)) out = out.split(v).join(REDACTED);
  for (const [re, replacement] of PATTERNS) out = out.replace(re, /** @type {any} */ (replacement));
  return out;
}

/**
 * @param {unknown[]} [values]
 */
export function createRedactor(values = []) {
  const list = normalize(values);
  return {
    values: list,
    /** @param {unknown[]} extra */
    with(extra) {
      return createRedactor([...list, ...extra]);
    },
    /** @param {unknown} text */
    scrub(text) {
      return scrub(text, list);
    },
  };
}
