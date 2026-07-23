// Unicode coordinate matrix + grapheme-safe editing.
// Covers the editor invariant "A cursor position resolves to three distinct coordinates".
import { test, expect } from 'bun:test';
import { EditorCoordinates } from '../EditorCoordinates';
import { TextDocument } from '../TextDocument';

test('grapheme count treats emoji and combining marks as one character', () => {
  expect(EditorCoordinates.Class.graphemeCount('abc')).toBe(3);
  expect(EditorCoordinates.Class.graphemeCount('a😀b')).toBe(3); // emoji is one grapheme (two UTF-16 units)
  expect(EditorCoordinates.Class.graphemeCount('é')).toBe(1); // e + combining acute = one cluster
  expect(EditorCoordinates.Class.graphemeCount('')).toBe(0);
  expect('a😀b'.length).toBe(4); // sanity: UTF-16 length differs from grapheme count
});

test('grapheme <-> UTF-16 mapping', () => {
  expect(EditorCoordinates.Class.graphemeToU16('a😀b', 0)).toBe(0);
  expect(EditorCoordinates.Class.graphemeToU16('a😀b', 1)).toBe(1);
  expect(EditorCoordinates.Class.graphemeToU16('a😀b', 2)).toBe(3); // after 'a'(1) + emoji(2)
  expect(EditorCoordinates.Class.graphemeToU16('a😀b', 3)).toBe(4);
  expect(EditorCoordinates.Class.u16ToGrapheme('a😀b', 3)).toBe(2);
  expect(EditorCoordinates.Class.u16ToGrapheme('a😀b', 1)).toBe(1);
});

test('display column: wide chars, combining marks, and tabs', () => {
  expect(EditorCoordinates.Class.graphemeWidth('中')).toBe(2);
  expect(EditorCoordinates.Class.displayColumn('中x', 1)).toBe(2);
  expect(EditorCoordinates.Class.displayColumn('中x', 2)).toBe(3);
  expect(EditorCoordinates.Class.displayColumn('áb', 1)).toBe(1); // combining adds no width
  expect(EditorCoordinates.Class.displayColumn('áb', 2)).toBe(2);
  expect(EditorCoordinates.Class.displayColumn('\tx', 1, 4)).toBe(4); // tab to next stop
  expect(EditorCoordinates.Class.displayColumn('ab\tx', 3, 4)).toBe(4);
  expect(EditorCoordinates.Class.lineWidth('中\tx', 4)).toBe(5); // 中(2) then tab to col 4, then x -> 5
});

test('backspace deletes a whole emoji, not half a surrogate pair', () => {
  const document = new TextDocument.Class() as any;
  document.loadFromText('a😀');
  const result = document.deleteBackward(0, 2); // cursor after the emoji (grapheme col 2)
  expect(document.line(0)).toBe('a'); // emoji fully removed, no lone surrogate
  expect(result).toEqual({ line: 0, col: 1 });
});

test('delete-forward removes a whole combining cluster', () => {
  const document = new TextDocument.Class() as any;
  document.loadFromText('éx'); // é (one grapheme, two units) + x
  document.deleteForward(0, 0);
  expect(document.line(0)).toBe('x');
});

test('insert astral char advances the cursor by one grapheme', () => {
  const document = new TextDocument.Class() as any;
  document.loadFromText('ab');
  const column = document.insertInline(0, 1, '😀');
  expect(document.line(0)).toBe('a😀b');
  expect(column).toBe(2); // grapheme col advanced by 1, not 2 (UTF-16)
});

test('split line at a grapheme boundary keeps the emoji intact', () => {
  const document = new TextDocument.Class() as any;
  document.loadFromText('a😀b');
  document.splitLine(0, 2); // split after the emoji
  expect(document.line(0)).toBe('a😀');
  expect(document.line(1)).toBe('b');
});

test('graphemeAtDisplayColumn inverts displayColumn on plain text', () => {
  const line = 'hello world';
  for (let graphemeIndex = 0; graphemeIndex <= EditorCoordinates.Class.graphemeCount(line); graphemeIndex++) {
    expect(EditorCoordinates.Class.graphemeAtDisplayColumn(line, EditorCoordinates.Class.displayColumn(line, graphemeIndex))).toBe(graphemeIndex);
  }
});

test('graphemeAtDisplayColumn: a hit inside a wide glyph resolves to that glyph', () => {
  const line = 'a中b'; // cells: a=0, 中=1..2 (wide), b=3
  expect(EditorCoordinates.Class.graphemeAtDisplayColumn(line, 0)).toBe(0); // on 'a'
  expect(EditorCoordinates.Class.graphemeAtDisplayColumn(line, 1)).toBe(1); // left cell of 中
  expect(EditorCoordinates.Class.graphemeAtDisplayColumn(line, 2)).toBe(1); // right cell of 中 -> still 中
  expect(EditorCoordinates.Class.graphemeAtDisplayColumn(line, 3)).toBe(2); // on 'b'
});

test('graphemeAtDisplayColumn: a hit inside a tab resolves to the tab', () => {
  const line = '\ta'; // tab covers cells 0..3 (tabWidth 4), 'a' at cell 4
  expect(EditorCoordinates.Class.graphemeAtDisplayColumn(line, 0)).toBe(0);
  expect(EditorCoordinates.Class.graphemeAtDisplayColumn(line, 3)).toBe(0); // still inside the tab
  expect(EditorCoordinates.Class.graphemeAtDisplayColumn(line, 4)).toBe(1); // on 'a'
});

test('graphemeAtDisplayColumn clamps past end-of-line and below zero', () => {
  expect(EditorCoordinates.Class.graphemeAtDisplayColumn('ab', 99)).toBe(2); // caret after the last char
  expect(EditorCoordinates.Class.graphemeAtDisplayColumn('ab', -5)).toBe(0);
});

// --- Horizontal flyweight: the prefix-sum index must be BEHAVIOURALLY identical to the old linear
//     scan, and must keep per-call cost sub-linear so a selection drag over a single 500k-column line
//     (a minified .js.map) stays smooth. Regression guard for "Cost tracks the actively observed set".

// Reference implementations = the pre-index linear algorithms, kept here as the oracle to diff against.
function referenceDisplayColumn(line: string, graphemeIndex: number, tabWidth = 4): number {
  const clusters = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)].map((s) => s.segment);
  const limit = Math.max(0, Math.min(graphemeIndex, clusters.length));
  let column = 0;
  for (let index = 0; index < limit; index++) {
    const cluster = clusters[index] ?? '';
    column += cluster === '\t' ? tabWidth - (column % tabWidth) : EditorCoordinates.Class.graphemeWidth(cluster);
  }
  return column;
}
function referenceGraphemeAtDisplayColumn(line: string, targetColumn: number, tabWidth = 4): number {
  if (targetColumn <= 0) return 0;
  const clusters = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)].map((s) => s.segment);
  let column = 0;
  for (let index = 0; index < clusters.length; index++) {
    const cluster = clusters[index] ?? '';
    const width = cluster === '\t' ? tabWidth - (column % tabWidth) : EditorCoordinates.Class.graphemeWidth(cluster);
    if (targetColumn < column + width) return index;
    column += width;
  }
  return clusters.length;
}

test('prefix index matches the linear reference across mixed tabs / wide glyphs / emoji', () => {
  const line = 'const\tx = "中文" + 😀 + `\ttab`;  // café';
  const count = EditorCoordinates.Class.graphemeCount(line);
  const width = EditorCoordinates.Class.lineWidth(line);
  expect(width).toBe(referenceDisplayColumn(line, count));
  for (let g = 0; g <= count; g++) {
    expect(EditorCoordinates.Class.displayColumn(line, g)).toBe(referenceDisplayColumn(line, g));
  }
  for (let col = -1; col <= width + 2; col++) {
    expect(EditorCoordinates.Class.graphemeAtDisplayColumn(line, col)).toBe(referenceGraphemeAtDisplayColumn(line, col));
  }
});

test('a single 200k-column line: 20k drag-style lookups stay sub-linear (no re-scan per call)', () => {
  // A minified index.js.map as ONE physical line. A drag re-runs displayColumn/graphemeAtDisplayColumn/
  // lineWidth every paint; with the prefix index these are O(1)/O(log n) after one build. A regression
  // to the old O(n) scan would make this loop ~20k*200k = 4e9 ops and blow far past the bound.
  const hugeLine = 'a'.repeat(200_000);
  const width = EditorCoordinates.Class.lineWidth(hugeLine); // builds the prefix once
  expect(width).toBe(200_000);
  const started = performance.now();
  let sink = 0;
  for (let i = 0; i < 20_000; i++) {
    const column = (i * 9973) % 200_000; // spread across the whole line, incl. deep-right positions
    sink += EditorCoordinates.Class.graphemeAtDisplayColumn(hugeLine, column);
    sink += EditorCoordinates.Class.displayColumn(hugeLine, column);
    sink += EditorCoordinates.Class.lineWidth(hugeLine);
  }
  const elapsed = performance.now() - started;
  expect(sink).toBeGreaterThan(0);
  expect(elapsed).toBeLessThan(1000); // O(1)/O(log n) finishes in ~10ms; O(n)-per-call cannot
});
