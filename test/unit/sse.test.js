import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DONE, createSSEParser, serializeComment, serializeEvent, serializeJson } from '../../src/sse.js';

/** Parse `chunks` with one parser, returning every item including those completed by end(). @param {(string | Uint8Array)[]} chunks */
function parseAll(chunks) {
  const p = createSSEParser();
  return [...chunks.flatMap((c) => p.push(c)), ...p.end()];
}

const STREAM =
  '﻿: OPENROUTER PROCESSING\r\n\r\n' +
  'event: message_start\r\ndata: {"a":1}\r\n\r\n' +
  'data: line one\ndata:line two\ndata:  two spaces\n\n' +
  'id: 7\rretry: 1500\rdata: cr only\r\r' +
  'data: {"text":"héllo \u{1F600}"}\n\n' +
  'event: ignored-without-data\n\n' +
  'data: [DONE]\n\n';

const EXPECTED = [
  { comment: ' OPENROUTER PROCESSING' },
  { data: '{"a":1}', event: 'message_start' },
  { data: 'line one\nline two\n two spaces' },
  { data: 'cr only', id: '7', retry: 1500 },
  { data: '{"text":"héllo \u{1F600}"}' },
  { data: '[DONE]' },
];

test('SSE parser: BOM, comments, CRLF/LF/CR, multi-line data, one optional space, id/retry, fields reset per event', () => {
  assert.deepEqual(parseAll([STREAM]), EXPECTED);
});

test('SSE parser: identical results for every chunking, including split CRLFs and split UTF-8 sequences', () => {
  const bytes = new TextEncoder().encode(STREAM);
  // byte by byte
  assert.deepEqual(parseAll([...bytes].map((b) => Uint8Array.of(b))), EXPECTED);
  // every two-way split
  for (let i = 1; i < bytes.length; i++) assert.deepEqual(parseAll([bytes.subarray(0, i), bytes.subarray(i)]), EXPECTED, `split at ${i}`);
  // pseudo-random multi-way splits
  let seed = 7;
  for (let round = 0; round < 50; round++) {
    const chunks = [];
    for (let i = 0; i < bytes.length; ) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      const n = 1 + (seed % 9);
      chunks.push(bytes.subarray(i, i + n));
      i += n;
    }
    assert.deepEqual(parseAll(chunks), EXPECTED);
  }
});

test('SSE parser: a final event without its blank line is dispatched at end(); a partial line is kept until then', () => {
  const p = createSSEParser();
  assert.deepEqual(p.push('data: {"x":'), []);
  assert.deepEqual(p.push('1}\ndata: more'), []);
  assert.deepEqual(p.end(), [{ data: '{"x":1}\nmore' }]);
  assert.deepEqual(parseAll(['data: a\r']), [{ data: 'a' }]);
});

test('SSE serializer round-trips through the parser', () => {
  const events = [{ data: 'one\ntwo', event: 'x', id: '3', retry: 10 }, { data: '{"k":"v"}' }, { data: '' }];
  const text = events.map(serializeEvent).join('') + serializeComment(' keep-alive\nnot a new line') + serializeJson({ a: [1] }) + DONE;
  assert.deepEqual(parseAll([text]), [...events, { comment: ' keep-alivenot a new line' }, { data: '{"a":[1]}' }, { data: '[DONE]' }]);
  assert.equal(DONE, 'data: [DONE]\n\n');
});
