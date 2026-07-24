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

  test('never splits an astral glyph across a boundary, and an emoji is TWO display cells', () => {
    // Three emoji at width 2: each rocket occupies 2 CELLS, so each gets its own row (never half a
    // surrogate pair, never two wide glyphs crammed into two cells).
    const rocket = '🚀';
    const segments = wrap(rocket.repeat(3), 2);
    expect(segments).toEqual([rocket, rocket, rocket]);
  });

  test('CJK wide characters wrap by DISPLAY CELLS (界 = 2 cells → two per 4-cell row)', () => {
    expect(wrap('界界界', 4)).toEqual(['界界', '界']);
  });

  test('a combining-mark cluster (é as e+◌́) is never split across rows', () => {
    const composed = 'e\u0301x'; // é (2 code points, ONE grapheme) then x
    expect(wrap(composed, 1)).toEqual(['e\u0301', 'x']);
  });

  test('a non-positive width clamps to a 1-cell budget (progress guaranteed, cluster-whole)', () => {
    expect(wrap('abc', 0)).toEqual(['a', 'b', 'c']);
  });
});

describe('WrapText geometry (segments + point↔offset mapping)', () => {
  const segmentsOf = (text: string, width: number) => WrapText.Class.segments(text, width);

  test('segments carry grapheme offsets + display widths', () => {
    const segments = segmentsOf('界x界', 3); // 界(2)+x(1)=3 cells row 1; 界 row 2
    expect(segments.map((segment) => segment.text)).toEqual(['界x', '界']);
    expect(segments[0]).toMatchObject({ graphemeStart: 0, graphemeCount: 2, displayWidth: 3, isLogicalLineStart: true });
    expect(segments[1]).toMatchObject({ graphemeStart: 2, graphemeCount: 1, displayWidth: 2, isLogicalLineStart: false });
  });

  test('forward mapping: caret after a wide cluster lands at its DISPLAY column (the éx probe fixed)', () => {
    // 'éx' at width 1: two graphemes → two rows; caret at the END (offset 2) = row 1, column 1.
    const segments = segmentsOf('éx', 1);
    expect(segments).toHaveLength(2);
    expect(WrapText.Class.visualPositionOf(segments, 2)).toEqual({ line: 1, column: 1 });
    // CJK: caret after 界界 (offset 2) at width 4 = row 0 column 4 (2 wide cells).
    const cjk = segmentsOf('界界界', 4);
    expect(WrapText.Class.visualPositionOf(cjk, 2)).toEqual({ line: 1, column: 0 }); // on the boundary → next row start
    expect(WrapText.Class.visualPositionOf(cjk, 1)).toEqual({ line: 0, column: 2 }); // after ONE wide cluster = column 2
  });

  test('inverse mapping: a display column inside a wide cluster snaps to its start', () => {
    const segments = segmentsOf('界界', 4);
    expect(WrapText.Class.graphemeAtVisualPosition(segments, 0, 0)).toBe(0);
    expect(WrapText.Class.graphemeAtVisualPosition(segments, 0, 1)).toBe(0); // inside 界's 2 cells
    expect(WrapText.Class.graphemeAtVisualPosition(segments, 0, 2)).toBe(1);
    expect(WrapText.Class.graphemeAtVisualPosition(segments, 0, 99)).toBe(2); // clamped to row end
  });

  test('round-trip: forward(inverse(p)) is stable across mixed-width text', () => {
    const text = 'a界b😀c';
    const segments = segmentsOf(text, 3);
    for (let offset = 0; offset <= 5; offset += 1) {
      const position = WrapText.Class.visualPositionOf(segments, offset);
      expect(WrapText.Class.graphemeAtVisualPosition(segments, position.line, position.column)).toBe(offset);
    }
  });
});

describe('WrapText.sliceByDisplayCells + clipToWidth (grapheme-safe)', () => {
  test('slicing é over cells [0,1) returns the WHOLE cluster, never a bare e', () => {
    expect(WrapText.Class.sliceByDisplayCells('éx', 0, 1)).toBe('é');
  });

  test('slicing an emoji never yields a lone surrogate', () => {
    expect(WrapText.Class.sliceByDisplayCells('😀x', 2, 3)).toBe('x'); // cells 2..3 = the x
    expect(WrapText.Class.sliceByDisplayCells('😀x', 0, 2)).toBe('😀');
  });

  test('displayWidth counts cells (CJK/emoji = 2)', () => {
    expect(WrapText.Class.displayWidth('界界界')).toBe(6);
    expect(WrapText.Class.displayWidth('a😀b')).toBe(4);
  });

  test('clipToWidth budgets the ellipsis and never exceeds the cell budget', () => {
    const clipped = WrapText.Class.clipToWidth('界界界界', 5);
    expect(WrapText.Class.displayWidth(clipped)).toBeLessThanOrEqual(5);
    expect(clipped.endsWith('…')).toBe(true);
    expect(WrapText.Class.clipToWidth('short', 10)).toBe('short'); // fits → untouched
  });
});
