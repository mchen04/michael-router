#!/usr/bin/env node
// Fake Upstash REST server (mocked evidence, for tests and benchmarks only).
//   node dev/fake-upstash.js --token T [--port 0] [--host 127.0.0.1] [--delay-ms N] [--fail] [--debug-dump]
// Endpoints: POST / (one command), POST /pipeline, POST /multi-exec, and GET /__dump with --debug-dump.
// Backed by src/store/memory.js, so commands have real Redis semantics. Never logs commands.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { RedisError, createMemoryStore } from '../src/store/memory.js';

const MAX_BODY = 4 * 1024 * 1024;

/**
 * @param {{token: string, port?: number, host?: string, delayMs?: number, fail?: boolean, debugDump?: boolean}} options
 */
export async function startFakeUpstash({ token, port = 0, host = '127.0.0.1', delayMs = 0, fail = false, debugDump = false }) {
  if (!token) throw new Error('a token is required');
  const store = createMemoryStore();

  /** @param {http.ServerResponse} res @param {number} status @param {unknown} body */
  const send = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) return send(res, 400, { error: 'ERR request too large' });
      chunks.push(chunk);
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: 'WRONGPASS invalid or missing auth token' });
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (path === '/__dump') {
      if (!debugDump) return send(res, 404, { error: 'not found' });
      return req.method === 'GET' ? send(res, 200, store.dump()) : send(res, 405, { error: 'method not allowed' });
    }
    if (!['/', '/pipeline', '/multi-exec'].includes(path)) return send(res, 404, { error: 'not found' });
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    if (fail) return send(res, 500, { error: 'fake upstash failure mode' });

    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return send(res, 400, { error: 'ERR failed to parse JSON body' });
    }
    try {
      if (path === '/') {
        try {
          return send(res, 200, { result: store.exec(body) });
        } catch (err) {
          if (err instanceof RedisError) return send(res, 400, { error: err.message });
          throw err;
        }
      }
      if (!Array.isArray(body) || !body.every(Array.isArray)) return send(res, 400, { error: 'ERR expected an array of commands' });
      if (path === '/multi-exec') {
        try {
          body.forEach(store.validate);
        } catch (err) {
          if (err instanceof RedisError) return send(res, 400, { error: `EXECABORT Transaction discarded because of: ${err.message}` });
          throw err;
        }
      }
      return send(res, 200, store.execEach(body));
    } catch {
      return send(res, 500, { error: 'ERR internal error' });
    }
  });

  await new Promise((resolve) => server.listen(port, host, () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://${address.address}:${address.port}`,
    port: address.port,
    store,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve(undefined));
        server.closeAllConnections();
      }),
  };
}

/** @param {string[]} argv */
function parseFlags(argv) {
  /** @type {{token?: string, port?: number, host?: string, delayMs?: number, fail?: boolean, debugDump?: boolean}} */
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = () => inline ?? argv[++i];
    if (flag === '--token') opts.token = value();
    else if (flag === '--port') opts.port = Number(value());
    else if (flag === '--host') opts.host = value();
    else if (flag === '--delay-ms') opts.delayMs = Number(value());
    else if (flag === '--fail') opts.fail = true;
    else if (flag === '--debug-dump') opts.debugDump = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const opts = parseFlags(process.argv.slice(2));
    const fake = await startFakeUpstash(/** @type {any} */ (opts));
    console.log(`listening on ${fake.url}`);
    const stop = async () => {
      await fake.close();
      process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } catch (err) {
    console.error(`fake-upstash failed: ${/** @type {Error} */ (err).message}`);
    process.exit(1);
  }
}
