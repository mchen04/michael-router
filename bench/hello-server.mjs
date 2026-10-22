#!/usr/bin/env node
// Cold-start baseline for bench/coldstart.mjs: the smallest node:http server, answering every
// request with a fixed JSON body. Prints one "listening on http://host:port" line.
import http from 'node:http';

const body = '{"object":"list","data":[]}';
const server = http.createServer((req, res) => {
  req.resume();
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
  res.end(body);
});
server.listen(0, '127.0.0.1', () => {
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  console.log(`listening on http://127.0.0.1:${port}`);
});
process.on('SIGTERM', () => process.exit(0));
