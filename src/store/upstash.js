// Upstash REST client: POST / (one command), /pipeline (not atomic), /multi-exec (transaction).
// Error messages are deliberately generic: they never include the URL, token or command arguments.

/**
 * @param {{url: string, token: string, timeoutMs?: number, fetch?: typeof fetch}} options
 */
export function createUpstashStore({ url, token, timeoutMs = 1500, fetch: fetchImpl = fetch }) {
  const base = url.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  /** @param {string} path @param {unknown} body */
  async function post(path, body) {
    // One timer, cleared once the call is over: an AbortSignal.timeout would still fire, and
    // allocate its error, long after every completed call.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('store request timed out', 'TimeoutError')), timeoutMs);
    /** @param {unknown} e @param {string} fallback */
    const fail = (e, fallback) =>
      new Error(/** @type {any} */ (e)?.name === 'TimeoutError' ? 'store request timed out' : fallback);
    let res;
    try {
      // redirect: 'error': following a redirect would re-send the token and the commands to another origin.
      res = await fetchImpl(base + path, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
    } catch (e) {
      clearTimeout(timer);
      throw fail(e, 'store unreachable');
    }
    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw fail(e, `store returned an unreadable response (HTTP ${res.status})`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`store returned HTTP ${res.status}`);
    return data;
  }

  /** @param {unknown} data */
  function unwrap(data) {
    if (!Array.isArray(data)) {
      throw new Error(data && typeof data === 'object' && 'error' in data ? 'store transaction discarded' : 'unexpected store response');
    }
    return data.map((e) => {
      if (!e || typeof e !== 'object' || 'error' in e) throw new Error('store command failed');
      return e.result ?? null;
    });
  }

  return {
    kind: /** @type {const} */ ('upstash'),
    /** @param {unknown[]} cmd */
    async command(cmd) {
      const data = await post('/', cmd);
      if (!data || typeof data !== 'object' || 'error' in data) throw new Error('store command failed');
      return data.result ?? null;
    },
    /** @param {unknown[][]} cmds */
    pipeline: async (cmds) => unwrap(await post('/pipeline', cmds)),
    /** @param {unknown[][]} cmds */
    multi: async (cmds) => unwrap(await post('/multi-exec', cmds)),
  };
}
