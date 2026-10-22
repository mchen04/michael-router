#!/usr/bin/env node
// Minimal fixed-response upstream for benchmarks (mocked evidence). No scenarios, no recording.
//   node bench/fake-upstream.mjs [--port 0] [--host 127.0.0.1] [--delay-ms 0] [--chunks 8] [--interval-ms 0]
//
// POST /v1beta/openai/chat/completions   OpenAI-compatible (the gemini pass-through path)
// POST /v1/messages                      Anthropic Messages (the Claude adapter's upstream)
// Point the router at it with GEMINI_BASE_URL=<url> and ANTHROPIC_BASE_URL=<url>.
//
// Every reply is serialized once at startup. A body with `"stream": true` gets an event stream:
// the headers and the first text delta after --delay-ms, then the other --chunks - 1 deltas
// --interval-ms apart, the closing events in the same write as the last delta. Otherwise one JSON
// body after --delay-ms. Any other path: 404. Prints one "listening on http://host:port" line.
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const CREATED = 1760000000;
const TEXT = 'Hello from the benchmark upstream.';
const USAGE_OPENAI = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
const USAGE_MESSAGES = { input_tokens: 12, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

/** @param {number} n @returns {string[]} n text fragments */
function fragments(n) {
  const words = TEXT.split(' ');
  return Array.from({ length: n }, (_, i) => `${words[i % words.length]} `);
}

/** @param {number} chunks */
function openAIReplies(chunks) {
  const model = 'gemini-2.5-flash-lite';
  const json = JSON.stringify({
    id: 'chatcmpl-bench',
    object: 'chat.completion',
    created: CREATED,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: TEXT }, finish_reason: 'stop' }],
    usage: USAGE_OPENAI,
  });
  /** @param {Record<string, unknown>} body */
  const event = (body) => `data: ${JSON.stringify({ id: 'chatcmpl-bench', object: 'chat.completion.chunk', created: CREATED, model, ...body })}\n\n`;
  const deltas = fragments(chunks).map((t) => event({ choices: [{ index: 0, delta: { content: t }, finish_reason: null }] }));
  const head = event({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  const tail = event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + event({ choices: [], usage: USAGE_OPENAI }) + 'data: [DONE]\n\n';
  return { json, stream: writes(head, deltas, tail) };
}

/** @param {number} chunks */
function messagesReplies(chunks) {
  const model = 'claude-haiku-5-5';
  const json = JSON.stringify({
    id: 'msg_bench',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: TEXT }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: USAGE_MESSAGES,
  });
  /** @param {Record<string, any>} body */
  const event = (body) => `event: ${body.type}\ndata: ${JSON.stringify(body)}\n\n`;
  const head =
    event({ type: 'message_start', message: { id: 'msg_bench', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...USAGE_MESSAGES, output_tokens: 1 } } }) +
    event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  const deltas = fragments(chunks).map((t) => event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }));
  const tail =
    event({ type: 'content_block_stop', index: 0 }) +
    event({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: USAGE_MESSAGES.output_tokens } }) +
    event({ type: 'message_stop' });
  return { json, stream: writes(head, deltas, tail) };
}

/** The stream as one buffer per write. @param {string} head @param {string[]} deltas @param {string} tail */
function writes(head, deltas, tail) {
  const parts = deltas.map((d, i) => (i === 0 ? head : '') + d + (i === deltas.length - 1 ? tail : ''));
  return parts.map((p) => Buffer.from(p));
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{port?: number, host?: string, delayMs?: number, chunks?: number, intervalMs?: number}} [options]
 */
export async function startFakeUpstream({ port = 0, host = '127.0.0.1', delayMs = 0, chunks = 8, intervalMs = 0 } = {}) {
  if (!(Number.isInteger(chunks) && chunks >= 1)) throw new Error('chunks must be a positive integer');
  const replies = {
    '/v1beta/openai/chat/completions': openAIReplies(chunks),
    '/v1/messages': messagesReplies(chunks),
  };
  const sse = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' };

  const server = http.createServer(async (req, res) => {
    const chunksIn = [];
    for await (const c of req) chunksIn.push(c);
    const reply = req.method === 'POST' ? replies[/** @type {keyof typeof replies} */ (req.url ?? '')] : undefined;
    if (!reply) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"error":{"message":"not found"}}');
    }
    let stream = false;
    try {
      stream = JSON.parse(Buffer.concat(chunksIn).toString('utf8'))?.stream === true;
    } catch {
      // not JSON: answer non-streaming
    }
    if (delayMs > 0) await sleep(delayMs);
    if (!stream) {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(reply.json) });
      return res.end(reply.json);
    }
    res.writeHead(200, sse);
    for (let i = 0; i < reply.stream.length; i++) {
      if (i > 0 && intervalMs > 0) await sleep(intervalMs);
      if (res.destroyed) return;
      res.write(reply.stream[i]);
    }
    res.end();
  });
  server.keepAliveTimeout = 60_000;
  await new Promise((resolve) => server.listen(port, host, () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://${address.address}:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve(undefined));
        server.closeAllConnections();
      }),
  };
}

/** @param {string[]} argv */
function parseFlags(argv) {
  /** @type {Record<string, number | string>} */
  const opts = {};
  const names = { '--port': 'port', '--host': 'host', '--delay-ms': 'delayMs', '--chunks': 'chunks', '--interval-ms': 'intervalMs' };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const name = names[/** @type {keyof typeof names} */ (flag)];
    if (!name) throw new Error(`unknown argument: ${flag}`);
    const value = inline ?? argv[++i];
    if (name === 'host') opts.host = value;
    else {
      const n = Number(value);
      if (!(Number.isInteger(n) && n >= 0)) throw new Error(`${flag} must be a non-negative integer`);
      opts[name] = n;
    }
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const fake = await startFakeUpstream(/** @type {any} */ (parseFlags(process.argv.slice(2))));
    console.log(`listening on ${fake.url}`);
    const stop = async () => {
      await fake.close();
      process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } catch (err) {
    console.error(`fake-upstream failed: ${/** @type {Error} */ (err).message}`);
    process.exit(1);
  }
}
