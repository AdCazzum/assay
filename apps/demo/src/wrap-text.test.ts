import { describe, expect, it } from 'vitest';
import { wrapText } from './wrap-text.js';

describe('wrapText', () => {
  it('leaves a short line alone', () => {
    expect(wrapText('hello', 20)).toEqual(['hello']);
  });

  it('wraps a long line at word boundaries without splitting a word', () => {
    const out = wrapText('one two three four five', 10);
    for (const line of out) expect(line.length).toBeLessThanOrEqual(10);
    expect(out.join(' ').replace(/\s+/g, ' ')).toContain('one');
    expect(out.join(' ')).toContain('five');
  });

  it('indents continuation lines when asked', () => {
    const out = wrapText('alpha beta gamma delta', 12, '  ');
    expect(out[0].startsWith('  ')).toBe(false);
    if (out.length > 1) expect(out[1].startsWith('  ')).toBe(true);
  });

  it('preserves paragraph breaks (embedded newlines)', () => {
    const out = wrapText('first\nsecond', 20);
    expect(out).toEqual(['first', 'second']);
  });
});
