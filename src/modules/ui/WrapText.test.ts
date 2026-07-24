import { describe, expect, test } from 'bun:test';
import { WrapText } from './WrapText';

const wrap = WrapText.Class.wrap;

describe('WrapText.wrap', () => {
  test('hard-wraps a long line into width-exact segments', () => {
    expect(wrap('abcdefg', 3)).toEqual(['abc', 'def', 'g']);
  });

  test('preserves explicit newlines and blank lines', () => {
    expect(wrap('ab\n\ncd', 5)).toEqual(['ab', '', 'cd']);
  });

  test('an empty string yields one empty visual line', () => {
    expect(wrap('', 5)).toEqual(['']);
  });

  test('never splits an astral glyph across a boundary (code-point safe)', () => {
    // Three 2-UTF16-unit emoji; wrapping at width 2 keeps whole glyphs (never half a surrogate pair).
    const rocket = '🚀';
    const segments = wrap(rocket.repeat(3), 2);
    expect(segments).toEqual([`${rocket}${rocket}`, rocket]);
    for (const segment of segments) expect(Array.from(segment).length).toBeLessThanOrEqual(2);
  });

  test('a non-positive width returns the text unwrapped (guard)', () => {
    expect(wrap('abc', 0)).toEqual(['abc']);
  });
});
