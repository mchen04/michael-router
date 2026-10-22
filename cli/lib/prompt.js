// Secret input. A terminal gets a no-echo prompt in raw mode (nothing is echoed, not even
// asterisks; backspace, Ctrl-U, Ctrl-D and escape sequences are handled; Ctrl-C restores the
// terminal and exits 130). Piped stdin is read to the end with one trailing newline removed.
// Secrets are never taken from arguments, so they never reach shell history or `ps`.
import { Buffer } from 'node:buffer';
import { CliError, EXIT, usageError } from './errors.js';

const MAX_SECRET_BYTES = 16 * 1024;
const MAX_PROMPT_BYTES = 4 * 1024 * 1024;

/**
 * @typedef {NodeJS.ReadableStream & {isTTY?: boolean, isRaw?: boolean, setRawMode?: (mode: boolean) => unknown,
 *   setEncoding: (e: BufferEncoding) => unknown, pause: () => unknown, resume: () => unknown}} Input
 * @typedef {{write: (s: string) => unknown}} Output
 */

/**
 * Read one line from a terminal without echoing it.
 * @param {{label: string, stdin: Input, stderr: Output}} options
 * @returns {Promise<string>}
 */
export function promptHidden({ label, stdin, stderr }) {
  return new Promise((resolve, reject) => {
    let value = '';
    let esc = 0; // 0 text, 1 after ESC, 2 inside a CSI sequence, 3 after ESC O
    const wasRaw = Boolean(stdin.isRaw);
    /** @param {CliError | null} err */
    const finish = (err) => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      try {
        stdin.setRawMode?.(wasRaw);
      } catch {
        // the terminal went away
      }
      stdin.pause();
      stderr.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    /** @param {string | Buffer} chunk */
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (esc === 1) {
          esc = ch === '[' ? 2 : ch === 'O' ? 3 : 0;
          continue;
        }
        if (esc === 2) {
          if (ch >= '@' && ch <= '~') esc = 0;
          continue;
        }
        if (esc === 3) {
          esc = 0;
          continue;
        }
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish(null);
        if (ch === '\u0003') return finish(new CliError('cancelled', EXIT.INTERRUPTED));
        if (ch === '\u007f' || ch === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (ch === '\u0015') value = '';
        else if (ch === '\u001b') esc = 1;
        else if (ch >= ' ') value += ch;
      }
    };
    const onEnd = () => finish(null);
    stdin.setRawMode?.(true); // before the prompt is shown, so nothing typed is ever echoed
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.once('end', onEnd);
    stderr.write(label);
    stdin.resume();
  });
}

/**
 * @param {Input} stdin
 * @param {number} max
 * @param {string} what
 */
async function readAll(stdin, max, what) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > max) throw usageError(`${what} on stdin is too long`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * A secret from the hidden prompt (terminal) or from stdin (piped). Never empty, never multi-line.
 * @param {{label: string, what: string, stdin: Input, stderr: Output, confirm?: boolean}} options
 * @returns {Promise<string>}
 */
export async function readSecret({ label, what, stdin, stderr, confirm = false }) {
  if (!stdin.isTTY) {
    const text = (await readAll(stdin, MAX_SECRET_BYTES, what)).replace(/\r?\n$/, '');
    if (text === '') throw usageError(`no ${what} on stdin`);
    if (/[\r\n]/.test(text)) throw usageError(`the ${what} on stdin must be a single line`);
    return text;
  }
  const value = await promptHidden({ label, stdin, stderr });
  if (value === '') throw usageError(`no ${what} entered`);
  if (confirm) {
    const again = await promptHidden({ label: 'Repeat to confirm: ', stdin, stderr });
    if (again !== value) throw usageError(`the two ${what} entries did not match`);
  }
  return value;
}

/** The prompt text for `ask` from piped stdin (one trailing newline removed). @param {Input} stdin */
export async function readStdinText(stdin) {
  return (await readAll(stdin, MAX_PROMPT_BYTES, 'the prompt')).replace(/\r?\n$/, '');
}
