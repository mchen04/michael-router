#!/usr/bin/env node
// Local node:http adapter around the exact handler Vercel runs, plus a static server for public/.
//   node dev/server.js [--port 8787] [--host 127.0.0.1] [--upstream-timeout-ms N]
// Configuration comes from the environment (see DESIGN §4). --upstream-timeout-ms shortens the
// 295 s upstream timeout (tests and benchmarks only; deployments always use the default). The
// client source is the socket address unless TRUST_PROXY_HEADERS=1. Prints one
// "listening on http://host:port" line.
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHandler, isProtected } from '../src/handler.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** The same static security headers vercel.json applies to every path. */
export const SECURITY_HEADERS = (() => {
  const vercel = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  /** @type {Record<string, string>} */
  const out = {};
  for (const rule of vercel.headers ?? []) {
    if (rule.source === '/(.*)') for (const h of rule.headers) out[h.key.toLowerCase()] = h.value;
  }
  return out;
})();

/**
 * @param {http.IncomingMessage} req
 * @param {AbortSignal} signal
 */
function toWebRequest(req, signal) {
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(new URL(/** @type {string} */ (req.url), 'http://localhost'), {
    method: req.method,
    headers,
    body: hasBody ? /** @type {ReadableStream} */ (Readable.toWeb(req)) : undefined,
    duplex: 'half',
    signal,
  });
}

/** Resolve once the socket drains or closes. @param {http.ServerResponse} res */
function drained(res) {
  if (res.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve(undefined);
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

/**
 * Stream a Web Response to node:http, flushing each chunk as it arrives (SSE).
 * @param {http.ServerResponse} res
 * @param {Response} response
 * @param {string | undefined} method
 */
async function writeWebResponse(res, response, method) {
  /** @type {Record<string, string | string[]>} */
  const headers = { ...SECURITY_HEADERS };
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie') headers[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  if (!response.body || method === 'HEAD') {
    res.end();
    await response.body?.cancel().catch(() => {});
    return;
  }
  res.flushHeaders();
  const reader = response.body.getReader();
  res.on('close', () => {
    if (!res.writableFinished) reader.cancel().catch(() => {});
  });
  try {
    for (;;) {
      if (res.destroyed) {
        await reader.cancel().catch(() => {}); // client went away before or while streaming
        break;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await drained(res);
    }
    res.end();
  } catch {
    res.destroy();
  }
}

/** @param {http.ServerResponse} res @param {number} status @param {string} text @param {Record<string, string>} [extra] */
function sendText(res, status, text, extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8', ...extra });
  res.end(text);
}

/** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
async function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed\n', { allow: 'GET, HEAD' });
  let file;
  try {
    file = path.join(PUBLIC_DIR, decodeURIComponent(new URL(/** @type {string} */ (req.url), 'http://localhost').pathname));
  } catch {
    return sendText(res, 400, 'Bad request\n');
  }
  if (file.includes('\0') || (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep))) return sendText(res, 404, 'Not found\n');
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const body = await readFile(file);
    const type = CONTENT_TYPES[/** @type {keyof typeof CONTENT_TYPES} */ (path.extname(file).toLowerCase())] ?? 'application/octet-stream';
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': type, 'content-length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    sendText(res, 404, 'Not found\n');
  }
}

/**
 * @param {{port?: number, host?: string, env?: Record<string, string | undefined>, upstreamTimeoutMs?: number,
 *   handler?: (request: Request, platform: object) => Promise<Response>}} [options]
 */
export async function startDevServer({ port = 8787, host = '127.0.0.1', env = process.env, upstreamTimeoutMs, handler } = {}) {
  /** @type {Set<Promise<unknown>>} */
  const pending = new Set();
  /** @param {Promise<unknown>} promise */
  const waitUntil = (promise) => {
    const tracked = Promise.resolve(promise)
      .catch(() => {})
      .finally(() => pending.delete(tracked));
    pending.add(tracked);
  };
  const handle = handler ?? createHandler({ env, waitUntil, upstreamTimeoutMs });

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url?.startsWith('/')) return sendText(res, 400, 'Bad request\n');
      if (!isProtected(new URL(req.url, 'http://localhost'))) return await serveStatic(req, res);
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) abort.abort();
      });
      const request = toWebRequest(req, abort.signal);
      const response = await handle(request, { waitUntil, remoteAddress: req.socket.remoteAddress });
      await writeWebResponse(res, response, req.method);
    } catch {
      if (!res.headersSent) sendText(res, 500, 'Internal server error\n');
      else res.destroy();
    }
  });
  await new Promise((resolve) => server.listen(port, host, () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  const shownHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    server,
    url: `http://${shownHost}:${address.port}`,
    port: address.port,
    pending,
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve(undefined));
        server.closeIdleConnections();
      });
      await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, 3000).unref())]);
    },
  };
}

/** @param {string[]} argv */
function parseFlags(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(port|host|upstream-timeout-ms)(?:=(.*))?$/.exec(argv[i]);
    if (!m) throw new Error(`unknown argument: ${argv[i]}`);
    flags[m[1]] = m[2] ?? argv[++i];
  }
  return flags;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const port = flags.port === undefined ? 8787 : Number(flags.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be 0..65535');
  const timeout = flags['upstream-timeout-ms'] === undefined ? undefined : Number(flags['upstream-timeout-ms']);
  if (timeout !== undefined && !(Number.isInteger(timeout) && timeout > 0)) throw new Error('--upstream-timeout-ms must be a positive integer');
  const dev = await startDevServer({ port, host: flags.host ?? '127.0.0.1', upstreamTimeoutMs: timeout });
  console.log(`listening on ${dev.url}`);
  const stop = async () => {
    await dev.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`dev server failed: ${err.message}`);
    process.exit(1);
  });
}
