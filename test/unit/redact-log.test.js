import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXCEPTION_FIELDS, LOG_FIELDS, createLogger } from '../../src/log.js';
import { REDACTED, createRedactor, scrub } from '../../src/redact.js';
import { ENV_KEYS, PASSWORD, ROUTER_SECRET, STORE_TOKEN } from '../helpers/fixtures.js';

test('redaction patterns: sk-ant, sk-or, AIza, Bearer, long hex and base64 tokens', () => {
  const cases = [
    ['key sk-ant-api03-AbC_dEf-123456789 here', `key ${REDACTED} here`],
    ['sk-or-v1-0123456789abcdef', REDACTED],
    ['AIzaSyA1234567890abcdefghijklmnopqrstu', REDACTED],
    ['Authorization: Bearer abc.def-ghi', `Authorization: Bearer ${REDACTED}`],
    ['authorization: bearer xyz', `authorization: Bearer ${REDACTED}`],
    [`hex ${'0123456789abcdef'.repeat(2)} end`, `hex ${REDACTED} end`],
    [`b64 ${'aB3dE6gH9+/'.repeat(4)}==`, `b64 ${REDACTED}`],
    [`b64url ${'Ab3_-'.repeat(9)}`, `b64url ${REDACTED}`],
  ];
  for (const [input, expected] of cases) assert.equal(scrub(input), expected, input);
});

test('redaction leaves ordinary text, model ids and short tokens alone', () => {
  for (const text of [
    'model anthropic/claude-sonnet-4.5 is not routable',
    'openrouter/some-very-long-lowercase-model-name-2025-preview',
    'upstream returned 529 overloaded_error',
    'request 1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed failed',
    'deadbeef',
  ]) {
    assert.equal(scrub(text), text);
  }
});

test('configured values and the presented bearer are replaced, longest first', () => {
  const r = createRedactor([...Object.values(ENV_KEYS), ROUTER_SECRET, STORE_TOKEN, 'abc', null, undefined]);
  const withBearer = r.with([PASSWORD]);
  const text = `p=${PASSWORD} s=${ROUTER_SECRET} t=${STORE_TOKEN} k=${ENV_KEYS.GEMINI_API_KEY} abc stays`;
  const out = withBearer.scrub(text);
  for (const secret of [PASSWORD, ROUTER_SECRET, STORE_TOKEN, ENV_KEYS.GEMINI_API_KEY]) assert.ok(!out.includes(secret), out);
  assert.equal(out, `p=${REDACTED} s=${REDACTED} t=${REDACTED} k=${REDACTED} abc stays`);
  assert.equal(r.scrub(`p=${PASSWORD}`), `p=${PASSWORD}`, 'the bearer is only scrubbed once presented');
  assert.equal(scrub(undefined), '');
  assert.equal(scrub(42), '42');
});

test('request log lines contain only allowlisted primitive fields', () => {
  /** @type {string[]} */
  const lines = [];
  const logger = createLogger({ sink: (l) => lines.push(l), errorSink: (l) => lines.push(l) });
  logger.request({
    request_id: 'r1',
    route: '/control/health',
    method: 'GET',
    status: 200,
    duration_ms: 1.2,
    store_ms: 0.4,
    cold: true,
    error_code: undefined,
    authorization: `Bearer ${PASSWORD}`,
    body: { prompt: 'secret prompt' },
    model: { nested: true },
  });
  const line = JSON.parse(lines[0]);
  assert.deepEqual(line, { request_id: 'r1', route: '/control/health', method: 'GET', status: 200, duration_ms: 1.2, store_ms: 0.4, cold: true });
  assert.ok(Object.keys(line).every((k) => LOG_FIELDS.includes(k)));
});

test('exception lines carry only name and scrubbed message', () => {
  /** @type {string[]} */
  const lines = [];
  const logger = createLogger({ sink: (l) => lines.push(l), errorSink: (l) => lines.push(l) });
  const err = new RangeError(`bad sk-ant-api03-SENTINELxyz and ${'q'.repeat(500)}`);
  err.stack = `stack with ${PASSWORD}`;
  logger.exception(err, { requestId: 'r2', redact: (s) => scrub(s, [PASSWORD]) });
  logger.exception({ name: 'weird name with spaces', message: 7 });
  const [a, b] = lines.map((l) => JSON.parse(l));
  assert.deepEqual(Object.keys(a), [...EXCEPTION_FIELDS]);
  assert.equal(a.exception, 'RangeError');
  assert.equal(a.message.length, 300);
  assert.ok(!a.message.includes('SENTINEL') && !lines[0].includes(PASSWORD));
  assert.equal(b.exception, 'Error');
  assert.equal(b.request_id, null);
});
