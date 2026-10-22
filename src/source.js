// Client source id: HMAC(source-key, normalized IP) truncated to 16 bytes hex.
// IPv4 uses the full address, IPv6 its /64 prefix; anything unparseable shares the `unknown` bucket.
import { createHmac } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

const UNKNOWN = Object.freeze({ key: 'unknown', display: 'unknown' });

/**
 * The client address: the trusted Vercel headers when configured, else the socket address.
 * @param {Request} request
 * @param {boolean} trustProxyHeaders
 * @param {string | undefined} remoteAddress
 */
export function clientAddress(request, trustProxyHeaders, remoteAddress) {
  if (!trustProxyHeaders) return remoteAddress ?? null;
  for (const name of ['x-vercel-forwarded-for', 'x-real-ip']) {
    const first = request.headers.get(name)?.split(',')[0].trim();
    if (first) return first;
  }
  return null;
}

/** @param {string} addr @returns {number[] | null} eight 16-bit groups */
function ipv6Groups(addr) {
  let text = addr;
  /** @type {number[] | null} */
  let v4 = null;
  const lastColon = text.lastIndexOf(':');
  if (text.includes('.', lastColon)) {
    const tail = text.slice(lastColon + 1);
    if (!isIPv4(tail)) return null;
    v4 = tail.split('.').map(Number);
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (/** @type {string} */ s) => (s === '' ? [] : s.split(':').map((g) => parseInt(g, 16)));
  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - left.length - right.length;
  if (halves.length === 1 ? fill !== 0 : fill < 0) return null;
  const groups = [...left, ...Array(halves.length === 2 ? fill : 0).fill(0), ...right];
  if (groups.length !== 8 || groups.some((g) => !(g >= 0 && g <= 0xffff))) return null;
  if (v4) {
    groups[6] = (v4[0] << 8) | v4[1];
    groups[7] = (v4[2] << 8) | v4[3];
  }
  return groups;
}

/**
 * @param {string | null | undefined} raw
 * @returns {{key: string, display: string}} `key` feeds the HMAC; `display` is what auth events show
 */
export function normalizeAddress(raw) {
  if (typeof raw !== 'string') return UNKNOWN;
  let addr = raw.trim();
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  addr = addr.replace(/%.*$/, ''); // zone index
  if (isIPv4(addr)) return { key: `ipv4:${addr}`, display: addr };
  if (!isIPv6(addr)) return UNKNOWN;
  const g = ipv6Groups(addr.toLowerCase());
  if (!g) return UNKNOWN;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const v4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`; // IPv4-mapped
    return { key: `ipv4:${v4}`, display: v4 };
  }
  const prefix = g.slice(0, 4);
  while (prefix.length && prefix[prefix.length - 1] === 0) prefix.pop();
  const display = `${prefix.map((x) => x.toString(16)).join(':')}::/64`;
  return { key: `ipv6:${display}`, display };
}

/**
 * @param {Buffer} sourceKey
 * @param {string} normalizedKey
 * @returns {string} 32 hex characters
 */
export function sourceId(sourceKey, normalizedKey) {
  return createHmac('sha256', sourceKey).update(normalizedKey).digest().subarray(0, 16).toString('hex');
}

/**
 * @param {Request} request
 * @param {{trustProxyHeaders: boolean, sourceKey: Buffer}} config
 * @param {string | undefined} remoteAddress
 * @returns {{id: string, display: string}}
 */
export function resolveSource(request, config, remoteAddress) {
  const { key, display } = normalizeAddress(clientAddress(request, config.trustProxyHeaders, remoteAddress));
  return { id: sourceId(config.sourceKey, key), display };
}
