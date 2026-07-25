import { describe, expect, it } from 'vitest';
import { composeColumns, composeSeparator } from './scenic-compositor.js';

describe('composeColumns', () => {
  it('zips rows side by side with the gutter', () => {
    const out = composeColumns(['a', 'b'], ['x', 'y'], { totalWidth: 11, gutter: ' | ' });
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('a    | x   ');
    expect(lines[1]).toBe('b    | y   ');
  });

  it('pads the shorter column with blank cells rather than misaligning rows', () => {
    const out = composeColumns(['only-left'], [], { totalWidth: 11, gutter: ' | ' });
    const lines = out.split('\n');
    expect(lines).toHaveLength(1);
    // leftWidth=4, rightWidth=4: 'only-left' truncates to 'onl…', right column is blank.
    expect(lines[0]).toBe('onl… |     ');
  });

  it('truncates a line longer than its column width with a trailing ellipsis, never wraps it', () => {
    const out = composeColumns(['this line is much too long for the column'], [], { totalWidth: 11, gutter: ' | ' });
    const [line] = out.split('\n');
    const [leftCell] = line.split(' | ');
    expect(leftCell.endsWith('…')).toBe(true);
    expect(leftCell.length).toBe(4);
  });

  it('rows count is the max of both columns, never dropping the longer side', () => {
    const out = composeColumns(['1', '2', '3'], ['x'], { totalWidth: 11, gutter: ' | ' });
    expect(out.split('\n')).toHaveLength(3);
  });

  it('ignores ANSI escapes when measuring width, so colored dashboard output is not over-truncated', () => {
    const colored = '\x1b[32mok\x1b[0m';
    const out = composeColumns([colored], [], { totalWidth: 11, gutter: ' | ' });
    const [line] = out.split('\n');
    expect(line.startsWith(colored)).toBe(true);
  });
});

describe('composeSeparator', () => {
  it('produces a full-width dash row', () => {
    const sep = composeSeparator({ totalWidth: 11, gutter: ' | ' });
    expect(sep).toHaveLength(11);
    expect(sep).toMatch(/^─+$/);
  });
});
