// PostgreSQL URL checks for the store (DESIGN §4). No pg import: config.js, which the CLI also
// loads, calls this. The caller reports a refused URL by its variable name, never its value.
//
// TLS is decided here and passed to pg explicitly: sslmode and channel_binding are removed from
// the string pg parses (pg would otherwise rebuild its own TLS settings from them, warning that
// sslmode=require means verify-full), and any other TLS parameter is refused for the same reason.
const TLS_MODES = new Set(['require', 'verify-ca', 'verify-full']);
const PLAIN_MODES = new Set(['disable', 'allow', 'prefer']);
const CHANNEL_BINDING = new Set(['disable', 'prefer', 'require']);

/** @param {string} host */
function isLocal(host) {
  if (host.startsWith('/')) return true; // a unix-socket directory
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** @param {string} s */
function decode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The host pg connects to: the `host` parameter when present, else the URL's host name. @param {URL} url */
export function urlHost(url) {
  return url.searchParams.get('host') || decode(url.hostname.replace(/^\[(.+)\]$/, '$1'));
}

/**
 * The first part a production URL lacks, or null. A production URL names its host (the host name
 * or a `host` parameter), user and password itself: pg fills a missing one from PGHOST, PGUSER or
 * PGPASSWORD (or a password file), which the deployment does not control.
 * @param {URL} url
 * @returns {'host' | 'user' | 'password' | null}
 */
export function missingUrlPart(url) {
  if (!urlHost(url)) return 'host';
  if (!url.username) return 'user';
  if (!url.password) return 'password';
  return null;
}

/**
 * @param {string} raw
 * @param {{production: boolean}} options
 * @returns {{connectionString: string, ssl: boolean, channelBinding: boolean} | null} null when refused
 */
export function parseDatabaseUrl(raw, { production }) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return null;
  if (production && missingUrlPart(url)) return null;
  const params = url.searchParams;
  for (const name of params.keys()) if ((name.startsWith('ssl') && name !== 'sslmode') || name === 'uselibpqcompat') return null;
  const sslmode = params.get('sslmode');
  const binding = params.get('channel_binding');
  if (binding !== null && !CHANNEL_BINDING.has(binding)) return null;
  const host = urlHost(url);
  let ssl;
  if (sslmode !== null && TLS_MODES.has(sslmode)) ssl = true;
  else if (!production && isLocal(host) && (sslmode === null || PLAIN_MODES.has(sslmode))) ssl = false;
  else return null;
  if (binding === 'require' && !ssl) return null; // channel binding exists only on TLS
  params.delete('sslmode');
  params.delete('channel_binding');
  return { connectionString: url.href, ssl, channelBinding: ssl && binding !== 'disable' };
}

/**
 * The pg connection options for a parsed URL, shared by the store and the operator's migrate
 * command so that both connect the same way: TLS with verify-full semantics (the system CAs, and
 * the host name, which pg also sends as SNI) and channel binding when enabled.
 * @param {{connectionString: string, ssl: boolean, channelBinding: boolean}} config from parseDatabaseUrl
 */
export function pgConnectionOptions({ connectionString, ssl, channelBinding }) {
  return { connectionString, ssl: ssl ? { rejectUnauthorized: true } : false, enableChannelBinding: channelBinding };
}

/**
 * Secret parts of a configured URL, for the redactor: the whole value and its password (as
 * written and decoded, from the user info or a `password` parameter). Never throws.
 * @param {string | undefined} raw
 * @returns {string[]}
 */
export function databaseUrlSecrets(raw) {
  if (!raw) return [];
  const out = [raw];
  try {
    const url = new URL(raw);
    out.push(url.href);
    for (const p of [url.password, url.searchParams.get('password') ?? '']) if (p) out.push(p, decode(p));
  } catch {
    // an unparsable value is still scrubbed as a whole
  }
  return [...new Set(out)];
}
