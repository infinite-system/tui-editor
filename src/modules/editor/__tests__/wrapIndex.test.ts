// The cumulative visual-row index behind totalVisualRows / firstVisualRowOfLine /
// lineSegmentAtVisualRow: per-frame queries must be O(1) (ZERO document reads on an unchanged
// revision — they used to walk every line per RootView update), edits must resync only the delta,
// and every answer must equal the naive full walk.
import { test, expect, describe } from 'bun:test';
import { EditorWrap } from '../EditorWrap';

class IndexProbeDocument {
  lineReads = 0;
  readonly revision = { value: 0 };
  constructor(private readonly lines: string[]) {}
  get lineCount(): number {
    return this.lines.length;
  }
  line(index: number): string {
    this.lineReads++;
    return this.lines[index] ?? '';
  }
  editLine(index: number, text: string): void {
    this.lines[index] = text;
    this.revision.value++;
  }
  insertLine(index: number, text: string): void {
    this.lines.splice(index, 0, text);
    this.revision.value++;
  }
  removeLine(index: number): void {
    this.lines.splice(index, 1);
    this.revision.value++;
  }
}

/** The naive ground truth: wrap every line and sum. */
function naiveTotal(document: IndexProbeDocument, width: number): number {
  let total = 0;
  for (let index = 0; index < document.lineCount; index++) {
    total += EditorWrap.Class.wrapLine(document.line(index), width).length;
  }
  return Math.max(1, total);
}

function makeLines(count: number): string[] {
  const lines: string[] = [];
  for (let index = 0; index < count; index++) {
    // Varied lengths: some wrap to 1 row, some to 2-4 rows at width 10.
    lines.push('word '.repeat(index % 7));
  }
  return lines;
}

describe('EditorWrap cumulative index', () => {
  test('extent equals the naive walk, and an unchanged revision costs ZERO document reads', () => {
    const document = new IndexProbeDocument(makeLines(200));
    const expected = naiveTotal(document, 10);
    expect(EditorWrap.Class.totalVisualRows(document, 10)).toBe(expected);
    document.lineReads = 0;
    // The per-frame calls: extent + a locate + a line bridge — all off the index, no line reads.
    expect(EditorWrap.Class.totalVisualRows(document, 10)).toBe(expected);
    EditorWrap.Class.firstVisualRowOfLine(document, 150, 10);
    EditorWrap.Class.lineSegmentAtVisualRow(document, Math.floor(expected / 2), 10);
    expect(document.lineReads).toBe(0);
  });

  test('an edit resyncs correctly (extent, bridge, and inverse agree with the naive walk)', () => {
    const document = new IndexProbeDocument(makeLines(120));
    EditorWrap.Class.totalVisualRows(document, 10); // build
    document.editLine(60, 'word '.repeat(12)); // now wraps much taller
    const expected = naiveTotal(document, 10);
    expect(EditorWrap.Class.totalVisualRows(document, 10)).toBe(expected);
    // Bridge and inverse are mutually consistent at every line boundary around the edit.
    for (const lineIndex of [0, 59, 60, 61, 119]) {
      const firstRow = EditorWrap.Class.firstVisualRowOfLine(document, lineIndex, 10);
      expect(EditorWrap.Class.lineSegmentAtVisualRow(document, firstRow, 10)).toEqual({
        lineIndex,
        segmentIndex: 0,
      });
    }
  });

  test('insertions and deletions realign the tail (head/tail identity trim)', () => {
    const document = new IndexProbeDocument(makeLines(100));
    EditorWrap.Class.totalVisualRows(document, 10);
    document.insertLine(5, 'word '.repeat(9));
    expect(EditorWrap.Class.totalVisualRows(document, 10)).toBe(naiveTotal(document, 10));
    document.removeLine(50);
    document.removeLine(0);
    expect(EditorWrap.Class.totalVisualRows(document, 10)).toBe(naiveTotal(document, 10));
    const lastLine = document.lineCount - 1;
    const lastFirstRow = EditorWrap.Class.firstVisualRowOfLine(document, lastLine, 10);
    expect(EditorWrap.Class.lineSegmentAtVisualRow(document, lastFirstRow, 10).lineIndex).toBe(lastLine);
  });

  test('a width change rebuilds the index for the new width', () => {
    const document = new IndexProbeDocument(makeLines(80));
    const atTen = EditorWrap.Class.totalVisualRows(document, 10);
    const atForty = EditorWrap.Class.totalVisualRows(document, 40);
    expect(atForty).toBe(naiveTotal(document, 40));
    expect(atForty).toBeLessThan(atTen); // wider viewport, fewer rows
    expect(EditorWrap.Class.totalVisualRows(document, 10)).toBe(naiveTotal(document, 10)); // back again
  });

  test('past-the-end locate clamps to the last visual row (true-last-row reachability)', () => {
    const document = new IndexProbeDocument(['short', 'word '.repeat(10)]);
    const total = EditorWrap.Class.totalVisualRows(document, 10);
    const lastRowCount = EditorWrap.Class.wrapLine(document.line(1), 10).length;
    expect(EditorWrap.Class.lineSegmentAtVisualRow(document, total + 100, 10)).toEqual({
      lineIndex: 1,
      segmentIndex: lastRowCount - 1,
    });
  });

  test('a revision-free document (test double) still answers correctly across mutations', () => {
    // No revision signal → every query resyncs via the identity sweep; answers stay exact.
    const lines = ['alpha beta gamma', 'delta'];
    const document = { lineCount: lines.length, line: (index: number) => lines[index] ?? '' };
    const before = EditorWrap.Class.totalVisualRows(document, 6);
    lines[1] = 'delta epsilon zeta eta theta';
    const after = EditorWrap.Class.totalVisualRows(document, 6);
    expect(after).toBeGreaterThan(before);
  });
});
