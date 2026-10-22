// Two local origins for redirect tests: `redirector` answers every request with a 307 to `trap`,
// which records whatever reaches it. A credentialed client must never deliver anything to the trap.
import http from 'node:http';

/** @param {http.RequestListener} listener */
async function listen(listener) {
  const server = http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { server, url: `http://127.0.0.1:${port}` };
}

export async function startRedirectTrap() {
  /** @type {{method: string | undefined, url: string | undefined, headers: http.IncomingHttpHeaders, body: string}[]} */
  const received = [];
  const trap = await listen(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"result":"PONG","data":[]}');
  });
  const redirector = await listen((req, res) => {
    req.resume();
    res.writeHead(307, { location: `${trap.url}${req.url}` });
    res.end();
  });
  return {
    url: redirector.url,
    received,
    async close() {
      for (const s of [trap.server, redirector.server]) {
        s.closeAllConnections();
        await new Promise((resolve) => s.close(() => resolve(undefined)));
      }
    },
  };
}
