import { test, expect, describe } from 'bun:test';
import { lineSelectionRange, buildSelectedSpans, type SpanColor } from './ui.selection';

const FG = '#cdd6f4';
const SEL = '#45475a';

describe('lineSelectionRange', () => {
  const sel = { start: { line: 2, col: 3 }, end: { line: 4, col: 5 } };

  test('null when no selection', () => {
    expect(lineSelectionRange(null, 2, 'abc')).toBeNull();
  });
  test('null for lines outside the selection', () => {
    expect(lineSelectionRange(sel, 1, 'abc')).toBeNull();
    expect(lineSelectionRange(sel, 5, 'abc')).toBeNull();
  });
  test('first line runs from start.col to end-of-content', () => {
    expect(lineSelectionRange(sel, 2, 'abcdefgh')).toEqual([3, 8]);
  });
  test('last line runs from column 0 to end.col', () => {
    expect(lineSelectionRange(sel, 4, 'abcdefgh')).toEqual([0, 5]);
  });
  test('middle line covers the whole content', () => {
    expect(lineSelectionRange(sel, 3, 'hello')).toEqual([0, 5]);
  });
  test('single-line selection', () => {
    const one = { start: { line: 0, col: 1 }, end: { line: 0, col: 4 } };
    expect(lineSelectionRange(one, 0, 'abcdef')).toEqual([1, 4]);
  });
  test('empty range collapses to null (empty middle line)', () => {
    expect(lineSelectionRange(sel, 3, '')).toBeNull();
  });
});

describe('buildSelectedSpans', () => {
  test('no selection: one fg-only chunk per span, no background', () => {
    const spans: SpanColor[] = [{ text: 'const', color: '#f00' }, { text: ' x', color: FG }];
    const out = buildSelectedSpans(spans, null, SEL);
    expect(out.map((c) => c.text)).toEqual(['const', ' x']);
    expect(out.every((c) => c.bg === undefined)).toBe(true);
    expect(out.every((c) => c.fg !== undefined)).toBe(true);
  });

  test('selection splits a span into before / shaded-mid / after', () => {
    const out = buildSelectedSpans([{ text: 'abcdef', color: FG }], [2, 4], SEL);
    expect(out.map((c) => c.text)).toEqual(['ab', 'cd', 'ef']);
    expect(out[0]!.bg).toBeUndefined();
    expect(out[1]!.bg).toBeDefined(); // the selected slice carries a background
    expect(out[1]!.fg).toBeDefined(); // ...and keeps its foreground
    expect(out[2]!.bg).toBeUndefined();
  });

  test('selection spanning multiple syntax spans shades each overlapping part', () => {
    const spans: SpanColor[] = [
      { text: 'let', color: '#f00' },
      { text: ' foo', color: FG },
    ];
    // cols: l=0 e=1 t=2 (space)=3 f=4 o=5 o=6 ; select [2,6) => 't', ' ', 'f', 'o'
    const out = buildSelectedSpans(spans, [2, 6], SEL);
    const shaded = out.filter((c) => c.bg !== undefined).map((c) => c.text).join('');
    expect(shaded).toBe('t fo');
  });

  test('full-span selection shades the entire span', () => {
    const out = buildSelectedSpans([{ text: 'word', color: FG }], [0, 4], SEL);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('word');
    expect(out[0]!.bg).toBeDefined();
  });

  test('grapheme-correct: never splits inside CJK or a combined emoji', () => {
    // '中' and '文' are one grapheme each; '👨‍👩‍👧' is a single ZWJ grapheme.
    const line = 'a中文👨‍👩‍👧b'; // graphemes: a | 中 | 文 | 👨‍👩‍👧 | b  (cols 0..4)
    // Select graphemes [1,4): 中, 文, the family emoji — must not slice inside them.
    const out = buildSelectedSpans([{ text: line, color: FG }], [1, 4], SEL);
    const before = out.find((c) => c.bg === undefined && c.text === 'a');
    const shaded = out.find((c) => c.bg !== undefined);
    const after = out.filter((c) => c.bg === undefined && c.text === 'b');
    expect(before).toBeDefined();
    expect(shaded!.text).toBe('中文👨‍👩‍👧');
    expect(after).toHaveLength(1);
    // The shaded text is a whole number of graphemes (round-trips through segmentation).
    expect([...new Intl.Segmenter().segment(shaded!.text)].map((s) => s.segment)).toEqual([
      '中',
      '文',
      '👨‍👩‍👧',
    ]);
  });
});
