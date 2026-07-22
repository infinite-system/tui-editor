// Word-wrap mapping layer: the pure logical↔visual projection (editor.wrap.ts) plus the editor's
// wrap MODE behavior. Covers the editor invariant "Word wrap is a pure view mapping".
import { test, expect } from 'bun:test';
import { EditorWrap, type WrapSegment, type WrappableDocument } from '../EditorWrap';

const {
  wrapLine,
  visualRowCount,
  segmentIndexForCursor,
  visualRowsForWindow,
  moveByVisualRows,
  scrollTopToRevealCursor,
} = EditorWrap.Class;
import { EditorCoordinates } from '../EditorCoordinates';
import { TextDocument } from '../TextDocument';
import { Editor } from '../Editor';

function documentFromLines(lines: string[]): WrappableDocument {
  return { lineCount: lines.length, line: (index: number) => lines[index] ?? '' };
}

/** Structural soundness: segments partition [0, graphemeCount); columns agree with displayColumn. */
function assertSegmentsSound(lineText: string, width: number, segments: WrapSegment[]): void {
  expect(segments.length).toBeGreaterThan(0);
  expect(segments[0]!.startGrapheme).toBe(0);
  expect(segments[segments.length - 1]!.endGrapheme).toBe(EditorCoordinates.Class.graphemeCount(lineText));
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    if (index > 0) expect(segment.startGrapheme).toBe(segments[index - 1]!.endGrapheme);
    expect(segment.startDisplayColumn).toBe(EditorCoordinates.Class.displayColumn(lineText, segment.startGrapheme));
    // The slice at grapheme boundaries never splits a cluster (no lone surrogates).
    const sliced = lineText.slice(
      EditorCoordinates.Class.graphemeToU16(lineText, segment.startGrapheme),
      EditorCoordinates.Class.graphemeToU16(lineText, segment.endGrapheme),
    );
    expect(sliced).toBe(EditorCoordinates.Class.graphemes(lineText).slice(segment.startGrapheme, segment.endGrapheme).join(''));
  }
}

test('wrapLine: empty line yields one empty segment', () => {
  expect(wrapLine('', 10)).toEqual([{ startGrapheme: 0, endGrapheme: 0, startDisplayColumn: 0 }]);
});

test('wrapLine: a line within the width is a single segment', () => {
  const segments = wrapLine('hello world', 20);
  expect(segments).toHaveLength(1);
  expect(segments[0]).toEqual({ startGrapheme: 0, endGrapheme: 11, startDisplayColumn: 0 });
});

test('wrapLine: exact-width line stays a single row; one more wraps', () => {
  expect(wrapLine('a'.repeat(10), 10)).toHaveLength(1);
  expect(wrapLine('a'.repeat(11), 10)).toHaveLength(2);
});

test('wrapLine: breaks at a word boundary, trailing space stays on the earlier row', () => {
  // width 10: "hello " (6) + "world" (5) = 11 > 10 -> break AFTER the space.
  const segments = wrapLine('hello world', 10);
  expect(segments).toHaveLength(2);
  expect(segments[0]!.endGrapheme).toBe(6); // "hello " including the space
  expect(segments[1]!.startGrapheme).toBe(6); // "world" starts the next row
  assertSegmentsSound('hello world', 10, segments);
});

test('wrapLine: an unbroken 500-char run hard-breaks at exactly the width', () => {
  const run = 'x'.repeat(500);
  const segments = wrapLine(run, 80);
  expect(segments).toHaveLength(Math.ceil(500 / 80)); // 7
  for (let index = 0; index < segments.length - 1; index++) {
    expect(segments[index]!.endGrapheme - segments[index]!.startGrapheme).toBe(80);
  }
  assertSegmentsSound(run, 80, segments);
});

test('wrapLine: word breaks preferred over hard breaks in mixed text', () => {
  const text = 'aaaa bbbb cccc dddd';
  const segments = wrapLine(text, 9);
  // Every non-final segment ends right after whitespace (a word break), never mid-word.
  const clusters = EditorCoordinates.Class.graphemes(text);
  for (let index = 0; index < segments.length - 1; index++) {
    expect(clusters[segments[index]!.endGrapheme - 1]).toBe(' ');
  }
  assertSegmentsSound(text, 9, segments);
});

test('wrapLine: CJK wide glyphs never split and never overflow the width', () => {
  const text = '中文字符测试中文字符测试'; // 12 clusters, 2 columns each
  const segments = wrapLine(text, 7); // 3 glyphs (6 cols) fit; a 4th (8) would overflow
  for (const segment of segments) {
    const segmentWidth =
      EditorCoordinates.Class.displayColumn(text, segment.endGrapheme) - segment.startDisplayColumn;
    expect(segmentWidth).toBeLessThanOrEqual(7);
  }
  expect(segments[0]!.endGrapheme).toBe(3);
  assertSegmentsSound(text, 7, segments);
});

test('wrapLine: emoji clusters (astral + ZWJ) stay whole across breaks', () => {
  const family = '👨‍👩‍👧‍👦'; // ZWJ sequence = ONE grapheme
  const text = `ab${family}cd${family}ef`;
  const segments = wrapLine(text, 4);
  assertSegmentsSound(text, 4, segments);
  for (const segment of segments) {
    const sliced = text.slice(
      EditorCoordinates.Class.graphemeToU16(text, segment.startGrapheme),
      EditorCoordinates.Class.graphemeToU16(text, segment.endGrapheme),
    );
    // No lone surrogate at either end of any slice.
    if (sliced.length > 0) {
      const firstCode = sliced.charCodeAt(0);
      expect(firstCode < 0xdc00 || firstCode > 0xdfff).toBe(true); // never starts on a LOW surrogate
      const lastCode = sliced.charCodeAt(sliced.length - 1);
      expect(lastCode < 0xd800 || lastCode > 0xdbff).toBe(true); // never ends on a HIGH surrogate
    }
  }
});

test('wrapLine: a single cluster wider than the width gets its own row (no split, no infinite loop)', () => {
  const segments = wrapLine('中中中', 1); // each glyph is 2 columns wide
  expect(segments).toHaveLength(3);
  for (let index = 0; index < 3; index++) {
    expect(segments[index]!.endGrapheme - segments[index]!.startGrapheme).toBe(1);
  }
});

test('wrapLine: tabs expand on the LOGICAL line column axis', () => {
  const text = '\tabc\tdef';
  const segments = wrapLine(text, 6);
  assertSegmentsSound(text, 6, segments);
  // Tab (cols 0-3) + "ab" fills width 6; break is tab-aware, not char-count based.
  expect(segments[0]!.startDisplayColumn).toBe(0);
  expect(segments[1]!.startDisplayColumn).toBe(EditorCoordinates.Class.displayColumn(text, segments[1]!.startGrapheme));
});

test('wrapLine: memoized — repeated calls return the identical array', () => {
  const first = wrapLine('hello world memo', 8);
  const second = wrapLine('hello world memo', 8);
  expect(second).toBe(first);
  expect(wrapLine('hello world memo', 9)).not.toBe(first); // width is part of the key
});

test('visualRowCount matches wrapLine length', () => {
  expect(visualRowCount('x'.repeat(25), 10)).toBe(3);
  expect(visualRowCount('', 10)).toBe(1);
});

test('segmentIndexForCursor: boundary column belongs to the NEXT segment; line end to the last', () => {
  const text = 'a'.repeat(25);
  const segments = wrapLine(text, 10); // [0,10) [10,20) [20,25)
  expect(segmentIndexForCursor(segments, 0)).toBe(0);
  expect(segmentIndexForCursor(segments, 9)).toBe(0);
  expect(segmentIndexForCursor(segments, 10)).toBe(1); // the wrap boundary renders at row 2 col 0
  expect(segmentIndexForCursor(segments, 20)).toBe(2);
  expect(segmentIndexForCursor(segments, 25)).toBe(2); // end of line = last segment
  expect(segmentIndexForCursor(segments, 999)).toBe(2);
});

test('visualRowsForWindow: a long line contributes multiple rows; the window is height-capped', () => {
  const documentWindow = documentFromLines(['short', 'y'.repeat(35), 'tail']);
  const rows = visualRowsForWindow(documentWindow, 0, 10, 5);
  expect(rows).toHaveLength(5);
  expect(rows.map((row) => [row.lineIndex, row.segmentIndex])).toEqual([
    [0, 0],
    [1, 0],
    [1, 1],
    [1, 2],
    [1, 3],
  ]);
  expect(rows[0]!.firstOfLine).toBe(true);
  expect(rows[2]!.firstOfLine).toBe(false);
});

test('visualRowsForWindow: starts at scrollTop\'s FIRST visual row and walks only the window', () => {
  const documentWindow = documentFromLines(['x'.repeat(100), 'a', 'b', 'c']);
  const rows = visualRowsForWindow(documentWindow, 1, 10, 3);
  expect(rows.map((row) => row.lineIndex)).toEqual([1, 2, 3]);
  expect(rows.every((row) => row.firstOfLine)).toBe(true);
});

test('visualRowsForWindow: clamps a negative scrollTop and survives an empty document window', () => {
  const documentWindow = documentFromLines(['only']);
  expect(visualRowsForWindow(documentWindow, -5, 10, 2)).toHaveLength(1);
  expect(visualRowsForWindow(documentWindow, 99, 10, 2)).toHaveLength(0);
});

test('moveByVisualRows: down within one wrapped line keeps the row-relative goal', () => {
  const documentWindow = documentFromLines(['a'.repeat(30)]);
  // Start at col 3 (row 0, visual col 3); one row down lands at visual col 3 of row 1 = col 13.
  const landing = moveByVisualRows(documentWindow, { line: 0, col: 3 }, 3, 1, 10);
  expect(landing).toEqual({ line: 0, col: 13 });
});

test('moveByVisualRows: crosses logical lines through wrapped rows in BOTH directions', () => {
  const documentWindow = documentFromLines(['a'.repeat(15), 'bbb']);
  // Line 0 wraps to rows [0,10) [10,15). From its last row, one down reaches line 1.
  const down = moveByVisualRows(documentWindow, { line: 0, col: 12 }, 2, 1, 10);
  expect(down).toEqual({ line: 1, col: 2 });
  // And one up from line 1 lands on line 0's LAST row.
  const up = moveByVisualRows(documentWindow, { line: 1, col: 2 }, 2, -1, 10);
  expect(up).toEqual({ line: 0, col: 12 });
});

test('moveByVisualRows: a long goal clamps INSIDE a non-final row (stays visually one row per step)', () => {
  const documentWindow = documentFromLines(['a'.repeat(30)]);
  const landing = moveByVisualRows(documentWindow, { line: 0, col: 0 }, 999, 1, 10);
  // Row 1 is [10,20); col 20 would render on row 2, so the landing clamps to 19.
  expect(landing).toEqual({ line: 0, col: 19 });
  const lastRowLanding = moveByVisualRows(documentWindow, { line: 0, col: 0 }, 999, 2, 10);
  expect(lastRowLanding).toEqual({ line: 0, col: 30 }); // final row may hold the line end
});

test('moveByVisualRows: clamps at the document\'s first and last visual rows', () => {
  const documentWindow = documentFromLines(['aaa', 'b'.repeat(15)]);
  expect(moveByVisualRows(documentWindow, { line: 0, col: 1 }, 1, -5, 10)).toEqual({ line: 0, col: 1 });
  const bottom = moveByVisualRows(documentWindow, { line: 1, col: 12 }, 2, 5, 10);
  expect(bottom.line).toBe(1);
  expect(bottom.col).toBeGreaterThanOrEqual(10); // stays on the last visual row
});

test('moveByVisualRows: wide-glyph landing is grapheme-aligned (never half a glyph)', () => {
  const documentWindow = documentFromLines(['abcdefghij', '中中中中中']);
  const landing = moveByVisualRows(documentWindow, { line: 0, col: 5 }, 5, 1, 10);
  expect(landing.line).toBe(1);
  // Goal column 5 falls INSIDE the third wide glyph (cols 4-5) -> grapheme index 2.
  expect(landing.col).toBe(2);
});

test('scrollTopToRevealCursor: above the window snaps to the cursor line', () => {
  const documentWindow = documentFromLines(Array.from({ length: 50 }, () => 'line'));
  expect(scrollTopToRevealCursor(documentWindow, 20, 5, 0, 10, 10)).toBe(5);
});

test('scrollTopToRevealCursor: keeps the top when the cursor row is already visible', () => {
  const documentWindow = documentFromLines(Array.from({ length: 50 }, () => 'line'));
  expect(scrollTopToRevealCursor(documentWindow, 3, 7, 0, 10, 10)).toBe(3);
});

test('scrollTopToRevealCursor: tall wrapped lines advance the top far enough (visual-row aware)', () => {
  // Lines 0..4 each wrap into 3 visual rows at width 10; height 5.
  const documentWindow = documentFromLines(Array.from({ length: 5 }, () => 'z'.repeat(25)));
  // Cursor on line 2's LAST row: rows(0..2) = 3+3+3 = 9 > 5 -> top must advance past line 1.
  const top = scrollTopToRevealCursor(documentWindow, 0, 2, 2, 10, 5);
  expect(top).toBe(2); // rows(line 2 through its 3rd row) = 3 <= 5, and top=1 would need 6
});

test('scrollTopToRevealCursor: far jump walks only O(height) lines (lower-bound start)', () => {
  const lines = Array.from({ length: 100000 }, () => 'line');
  let reads = 0;
  const documentWindow: WrappableDocument = {
    lineCount: lines.length,
    line: (index: number) => {
      reads += 1;
      return lines[index] ?? '';
    },
  };
  const top = scrollTopToRevealCursor(documentWindow, 0, 99999, 0, 80, 20);
  expect(top).toBe(99980);
  expect(reads).toBeLessThan(100); // never O(document)
});

test('property: segments partition, respect the width, and never split clusters', () => {
  const samples = [
    'The quick brown fox jumps over the lazy dog',
    '中文 mixed with ascii and 😀 emoji plus \t tabs',
    'no-spaces-'.repeat(30),
    ' '.repeat(40),
    'é'.repeat(90) + ' tail',
    'a\tb\tc\td\te\tf\tg\th',
  ];
  for (const sample of samples) {
    for (const width of [1, 2, 5, 8, 13, 40, 200]) {
      const segments = wrapLine(sample, width);
      assertSegmentsSound(sample, width, segments);
      for (const segment of segments) {
        const clusterCount = segment.endGrapheme - segment.startGrapheme;
        const segmentWidth = EditorCoordinates.Class.displayColumn(sample, segment.endGrapheme) - segment.startDisplayColumn;
        // Width respected unless the segment is a single oversized cluster (which cannot split).
        if (clusterCount > 1) expect(segmentWidth).toBeLessThanOrEqual(width);
      }
    }
  }
});

// --- editor MODE behavior (the contract's impossibles) --------------------------------------

function editorWithText(text: string, width: number, height: number): Editor.Instance {
  const editor = new Editor.Class();
  editor.document.loadFromText(text, '/tmp/wrap-fixture.txt');
  editor.hasDocument.value = true;
  editor.viewport.setSize(width, height);
  return editor;
}

test('toggling word wrap NEVER mutates the document (pure view mapping)', () => {
  const editor = editorWithText('alpha beta gamma delta epsilon zeta', 10, 5);
  const revisionBefore = editor.document.revision.value;
  const textBefore = editor.document.text;
  editor.toggleWordWrap();
  editor.toggleWordWrap();
  expect(editor.document.revision.value).toBe(revisionBefore);
  expect(editor.document.text).toBe(textBefore);
  expect(editor.document.dirty.value).toBe(false);
});

test('enabling wrap forces scrollLeft to 0 and keeps it inert', () => {
  const editor = editorWithText('x'.repeat(200) + '\nshort', 20, 5);
  editor.placeCursor(0, 150); // wrap OFF: auto-hscroll follows the caret
  expect(editor.viewport.scrollLeft.value).toBeGreaterThan(0);
  editor.toggleWordWrap();
  expect(editor.wordWrap.value).toBe(true);
  expect(editor.viewport.scrollLeft.value).toBe(0);
  editor.placeCursor(0, 180); // caret moves stay vertical-only in wrap mode
  expect(editor.viewport.scrollLeft.value).toBe(0);
});

test('wrap mode vertical movement steps VISUAL rows within a long line', () => {
  const editor = editorWithText('a'.repeat(50) + '\nnext', 10, 8);
  editor.toggleWordWrap();
  editor.placeCursor(0, 3);
  editor.moveVertical(1);
  expect(editor.cursor.line.value).toBe(0); // still the same logical line...
  expect(editor.cursor.col.value).toBe(13); // ...one visual row (10 columns) further
  editor.moveVertical(-1);
  expect(editor.cursor.col.value).toBe(3);
});

test('wrap OFF restores the clip+h-scroll behavior (goal returns to the absolute display column)', () => {
  const editor = editorWithText('b'.repeat(120), 20, 5);
  editor.toggleWordWrap();
  editor.placeCursor(0, 45);
  editor.toggleWordWrap(); // back OFF
  expect(editor.wordWrap.value).toBe(false);
  expect(editor.cursor.goalColumn.value).toBe(45); // absolute display column again
  expect(editor.viewport.scrollLeft.value).toBeGreaterThan(0); // h-scroll follows the caret again
});
