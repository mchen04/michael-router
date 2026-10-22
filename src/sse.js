// Incremental Server-Sent Events parser and serializer.
//
// The parser follows the WHATWG EventSource line rules: CRLF, LF or CR line endings (a CRLF split
// across two chunks is one line ending), `:` comment lines, `field: value` with one optional space
// after the colon, multi-line `data:` joined with "\n", a leading BOM ignored, and blank lines
// dispatching events. Chunks may split events, lines or UTF-8 sequences anywhere. Two deliberate
// relay-oriented differences: comments are reported (in order) instead of being dropped, and at
// end of input a final event that lacks only its terminating blank line is still dispatched.

/**
 * @typedef {{data: string, event?: string, id?: string, retry?: number}} SSEEvent
 * @typedef {{comment: string}} SSEComment
 * @typedef {SSEEvent | SSEComment} SSEItem
 */

export function createSSEParser() {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let started = false;
  let skipLF = false;
  /** @type {string[]} */
  let data = [];
  /** @type {string | undefined} */
  let event;
  /** @type {string | undefined} */
  let id;
  /** @type {number | undefined} */
  let retry;

  /** @param {SSEItem[]} out */
  function dispatch(out) {
    if (data.length) {
      /** @type {SSEEvent} */
      const e = { data: data.join('\n') };
      if (event !== undefined) e.event = event;
      if (id !== undefined) e.id = id;
      if (retry !== undefined) e.retry = retry;
      out.push(e);
    }
    data = [];
    event = id = retry = undefined;
  }

  /** @param {string} line @param {SSEItem[]} out */
  function processLine(line, out) {
    if (line === '') return dispatch(out);
    if (line[0] === ':') return void out.push({ comment: line.slice(1) });
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value.includes('\0') ? id : value;
    else if (field === 'retry') retry = /^\d+$/.test(value) ? Number(value) : retry;
  }

  /** @param {string} text @param {SSEItem[]} out */
  function feed(text, out) {
    if (!text) return;
    if (!started) {
      started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    if (skipLF && text) {
      skipLF = false;
      if (text[0] === '\n') text = text.slice(1);
    }
    buffer += text;
    let pos = 0;
    let cr = buffer.indexOf('\r');
    let lf = buffer.indexOf('\n');
    while (cr !== -1 || lf !== -1) {
      let end;
      let next;
      if (lf !== -1 && (cr === -1 || lf < cr)) {
        end = lf;
        next = lf + 1;
      } else {
        end = cr;
        if (cr + 1 < buffer.length) next = buffer[cr + 1] === '\n' ? cr + 2 : cr + 1;
        else {
          next = cr + 1;
          skipLF = true; // a CRLF may be split across chunks
        }
      }
      processLine(buffer.slice(pos, end), out);
      pos = next;
      if (cr !== -1 && cr < pos) cr = buffer.indexOf('\r', pos);
      if (lf !== -1 && lf < pos) lf = buffer.indexOf('\n', pos);
    }
    buffer = buffer.slice(pos);
  }

  return {
    /**
     * @param {Uint8Array | string} chunk
     * @returns {SSEItem[]} the comments and complete events in this chunk, in order
     */
    push(chunk) {
      /** @type {SSEItem[]} */
      const out = [];
      feed(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }), out);
      return out;
    },
    /** @returns {SSEItem[]} whatever the end of input completes */
    end() {
      /** @type {SSEItem[]} */
      const out = [];
      feed(decoder.decode(), out);
      if (buffer) processLine(buffer, out);
      buffer = '';
      dispatch(out);
      return out;
    },
  };
}

/**
 * @param {SSEEvent} e
 * @returns {string} the event block, terminated by a blank line
 */
export function serializeEvent({ data, event, id, retry }) {
  let out = '';
  if (event !== undefined) out += `event: ${event}\n`;
  if (id !== undefined) out += `id: ${id}\n`;
  if (retry !== undefined) out += `retry: ${retry}\n`;
  for (const line of String(data).split(/\r\n|\r|\n/)) out += `data: ${line}\n`;
  return `${out}\n`;
}

/** @param {string} text comment text after the colon @returns {string} */
export const serializeComment = (text) => `:${text.replace(/[\r\n]/g, '')}\n\n`;

/** @param {unknown} value @returns {string} `data: <json>` event */
export const serializeJson = (value) => `data: ${JSON.stringify(value)}\n\n`;

export const DONE = 'data: [DONE]\n\n';
