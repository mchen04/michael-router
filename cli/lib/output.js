// Terminal output: colors (only on a TTY, never with --no-color or NO_COLOR), aligned tables,
// and number, cost, duration and time formatting.

/**
 * @param {{isTTY?: boolean}} stream
 * @param {Record<string, string | boolean>} flags
 * @param {Record<string, string | undefined>} env
 */
export function colorEnabled(stream, flags, env) {
  if (flags['no-color']) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  return Boolean(stream.isTTY);
}

/** @typedef {(s: string) => string} Style */

/** @param {boolean} enabled */
export function palette(enabled) {
  /** @param {number} open @param {number} close @returns {Style} */
  const wrap = (open, close) => (s) => (enabled && s !== '' ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39) };
}

/** @typedef {ReturnType<typeof palette>} Palette */
/** @typedef {string | {text: string, style?: Style}} Cell */
/** @typedef {{header: string, right?: boolean}} Column */

/** @param {string} s */
const width = (s) => Array.from(s).length;
/** @param {Cell} cell */
const textOf = (cell) => (typeof cell === 'string' ? cell : cell.text);

/**
 * Render a table: bold header, two spaces between columns, numbers right-aligned, an optional
 * bold last row (totals). Styles are applied after padding so alignment ignores escape codes.
 * @param {Column[]} columns
 * @param {Cell[][]} rows
 * @param {Palette} c
 * @param {{totals?: boolean}} [options]
 */
export function renderTable(columns, rows, c, { totals = false } = {}) {
  const widths = columns.map((col, i) => Math.max(width(col.header), ...rows.map((r) => width(textOf(r[i] ?? '')))));
  /** @param {Cell[]} cells @param {Style | null} rowStyle */
  const line = (cells, rowStyle) =>
    cells
      .map((cell, i) => {
        const text = textOf(cell ?? '');
        const pad = ' '.repeat(widths[i] - width(text));
        const style = (typeof cell === 'object' && cell.style) || rowStyle || ((/** @type {string} */ s) => s);
        return columns[i].right ? pad + style(text) : style(text) + pad;
      })
      .join('  ')
      .trimEnd();
  const out = [line(columns.map((col) => col.header), c.bold)];
  rows.forEach((row, i) => out.push(line(row, totals && i === rows.length - 1 ? c.bold : null)));
  return `${out.join('\n')}\n`;
}

/** Key/value lines with aligned keys. @param {[string, string][]} pairs @param {Palette} c */
export function renderPairs(pairs, c) {
  const w = Math.max(...pairs.map(([k]) => width(k)));
  return pairs.map(([k, v]) => `${c.bold(k.padEnd(w))}  ${v}`).join('\n') + '\n';
}

/**
 * Model text for a terminal: C0 controls other than newline and tab, DEL and C1 controls are
 * removed, so a reply cannot move the cursor, retitle the window or start an escape sequence.
 * @param {string} s
 */
export const terminalSafe = (s) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');

/** @param {unknown} n */
export const fmtInt = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '-');

/** @param {number | undefined} ms */
export function fmtMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '-';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** @param {number} usd */
export function fmtUsd(usd) {
  if (usd === 0) return '$0.00';
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  if (usd >= 0.000001) return `$${usd.toFixed(6)}`;
  return '<$0.000001';
}

/**
 * Table marker for an aggregate cost (DESIGN §7): `$0.0123 est`, `$0.0040 exact`, `$0.02 mixed`,
 * `unknown`, `≥ $0.05 partial` (some requests had no known cost, so the sum is a lower bound).
 * @param {number} usd @param {string} status
 */
export function costMarker(usd, status) {
  switch (status) {
    case 'exact':
      return `${fmtUsd(usd)} exact`;
    case 'estimated':
      return `${fmtUsd(usd)} est`;
    case 'mixed':
      return `${fmtUsd(usd)} mixed`;
    case 'partial':
      return `≥ ${fmtUsd(usd)} partial`;
    default:
      return 'unknown';
  }
}

/** Footer wording for one request's cost: `$0.000105 estimated`, `$0.001230 exact`, `unknown`. @param {{usd: number, status: string}} cost */
export const costWords = (cost) => (cost.status === 'unknown' ? 'unknown' : `${fmtUsd(cost.usd)} ${cost.status}`);

/** @param {number} n */
const two = (n) => String(n).padStart(2, '0');

/**
 * Local time plus a relative age: `2026-10-21 14:03:12 (5m ago)`.
 * @param {unknown} iso @param {number} nowMs
 */
export function fmtTime(iso, nowMs) {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '-';
  const d = new Date(t);
  const local = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  return `${local} (${relative(nowMs - t)})`;
}

/** @param {number} ms */
export function relative(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
