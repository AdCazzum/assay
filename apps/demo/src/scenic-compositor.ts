/**
 * The dumb, deliberate two-column zipper (issue #94's layout): reuses
 * `@assay/dashboard`'s `renderState()` verbatim for the right column (the
 * caller passes its already-rendered lines in), and this file's only job is
 * side-by-side string composition with a fixed gutter, never a second
 * renderer.
 *
 * Truncation, not wrapping: a line longer than its column's width is cut
 * with a trailing `…`, never wrapped onto extra rows (the design doc's own
 * "accepted tradeoffs" -- wrapping would desynchronize the two columns' row
 * counts, and the whole point of a fixed two-column layout is that row N on
 * the left and row N on the right are not claimed to correspond to each
 * other in time, only to occupy the same horizontal band on screen). A
 * truncated line is never hidden from the underlying capture file, only from
 * this one rendered frame -- the footer this module's caller prints says so.
 */

export type ComposeOptions = {
  /** Total screen width to compose to. Defaults to 100 (matches the mockup in the design doc). */
  totalWidth?: number;
  /** Column separator. Defaults to ` │ `. */
  gutter?: string;
};

const DEFAULT_TOTAL_WIDTH = 100;
const DEFAULT_GUTTER = ' │ ';

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Pads or truncates `text` to exactly `width` *visible* columns, ignoring ANSI escapes when measuring (but only stripping them from plain text -- callers composing colored dashboard output should pass color: false, matching every fixture and test in this repo). */
function fitCell(text: string, width: number): string {
  const visible = stripAnsi(text);
  if (visible.length <= width) return text + ' '.repeat(width - visible.length);
  return `${visible.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * Zips `left`/`right` line arrays into one two-column block, row by row, up
 * to whichever column has more rows (the shorter one pads with blank cells).
 * Column widths split `totalWidth` evenly around the gutter.
 */
export function composeColumns(
  left: readonly string[],
  right: readonly string[],
  opts: ComposeOptions = {},
): string {
  const totalWidth = opts.totalWidth ?? DEFAULT_TOTAL_WIDTH;
  const gutter = opts.gutter ?? DEFAULT_GUTTER;
  const leftWidth = Math.max(1, Math.floor((totalWidth - gutter.length) / 2));
  const rightWidth = Math.max(1, totalWidth - gutter.length - leftWidth);

  const rows = Math.max(left.length, right.length);
  const lines: string[] = [];
  for (let i = 0; i < rows; i++) {
    lines.push(`${fitCell(left[i] ?? '', leftWidth)}${gutter}${fitCell(right[i] ?? '', rightWidth)}`);
  }
  return lines.join('\n');
}

/** A full-width separator row (`───...─┴─...───`), matching the mockup's header underline. */
export function composeSeparator(opts: ComposeOptions = {}): string {
  const totalWidth = opts.totalWidth ?? DEFAULT_TOTAL_WIDTH;
  const gutter = opts.gutter ?? DEFAULT_GUTTER;
  const leftWidth = Math.max(1, Math.floor((totalWidth - gutter.length) / 2));
  const rightWidth = Math.max(1, totalWidth - gutter.length - leftWidth);
  return `${'─'.repeat(leftWidth)}${'─'.repeat(gutter.length)}${'─'.repeat(rightWidth)}`.slice(0, totalWidth);
}
