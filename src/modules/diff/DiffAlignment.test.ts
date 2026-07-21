import { describe, expect, test } from 'bun:test';
import { DiffAlignment, type AlignedRow } from './DiffAlignment';

function align(previousVersionText: string, currentVersionText: string): readonly AlignedRow[] {
  return DiffAlignment.Class.align(previousVersionText, currentVersionText).alignedRows;
}

describe('DiffAlignment', () => {
  test('pure insertion places a left filler between paired equal lines', () => {
    expect(align('one\nthree', 'one\ntwo\nthree')).toEqual([
      { kind: 'equal', leftLineNumber: 1, rightLineNumber: 1 },
      { kind: 'added', leftLineNumber: null, rightLineNumber: 2 },
      { kind: 'equal', leftLineNumber: 2, rightLineNumber: 3 },
    ]);
  });

  test('pure deletion places a right filler between paired equal lines', () => {
    expect(align('one\ntwo\nthree', 'one\nthree')).toEqual([
      { kind: 'equal', leftLineNumber: 1, rightLineNumber: 1 },
      { kind: 'deleted', leftLineNumber: 2, rightLineNumber: null },
      { kind: 'equal', leftLineNumber: 3, rightLineNumber: 2 },
    ]);
  });

  test('a replacement with more current lines pairs first then adds left fillers', () => {
    expect(align('before\nold\nafter', 'before\nnew one\nnew two\nafter')).toEqual([
      { kind: 'equal', leftLineNumber: 1, rightLineNumber: 1 },
      { kind: 'modified', leftLineNumber: 2, rightLineNumber: 2 },
      { kind: 'added', leftLineNumber: null, rightLineNumber: 3 },
      { kind: 'equal', leftLineNumber: 3, rightLineNumber: 4 },
    ]);
  });

  test('a replacement with more previous lines pairs first then adds right fillers', () => {
    expect(align('before\nold one\nold two\nafter', 'before\nnew\nafter')).toEqual([
      { kind: 'equal', leftLineNumber: 1, rightLineNumber: 1 },
      { kind: 'modified', leftLineNumber: 2, rightLineNumber: 2 },
      { kind: 'deleted', leftLineNumber: 3, rightLineNumber: null },
      { kind: 'equal', leftLineNumber: 4, rightLineNumber: 3 },
    ]);
  });

  test('interleaved hunks produce separate contiguous change blocks and navigable starts', () => {
    const result = DiffAlignment.Class.align(
      'alpha\nbeta\ngamma\ndelta\nepsilon',
      'alpha\ninserted\nbeta\nchanged\ndelta\nepsilon\ntail',
    );
    expect(result.alignedRows).toEqual([
      { kind: 'equal', leftLineNumber: 1, rightLineNumber: 1 },
      { kind: 'added', leftLineNumber: null, rightLineNumber: 2 },
      { kind: 'equal', leftLineNumber: 2, rightLineNumber: 3 },
      { kind: 'modified', leftLineNumber: 3, rightLineNumber: 4 },
      { kind: 'equal', leftLineNumber: 4, rightLineNumber: 5 },
      { kind: 'equal', leftLineNumber: 5, rightLineNumber: 6 },
      { kind: 'added', leftLineNumber: null, rightLineNumber: 7 },
    ]);
    expect(result.changeBlocks).toEqual([
      { startAlignedRowIndex: 1, endAlignedRowIndexExclusive: 2 },
      { startAlignedRowIndex: 3, endAlignedRowIndexExclusive: 4 },
      { startAlignedRowIndex: 6, endAlignedRowIndexExclusive: 7 },
    ]);
    expect(DiffAlignment.Class.nextChangeBlockStart(result.changeBlocks, 1)).toBe(3);
    expect(DiffAlignment.Class.nextChangeBlockStart(result.changeBlocks, 3)).toBe(6);
    expect(DiffAlignment.Class.nextChangeBlockStart(result.changeBlocks, 6)).toBeNull();
    expect(DiffAlignment.Class.previousChangeBlockStart(result.changeBlocks, 6)).toBe(3);
    expect(DiffAlignment.Class.previousChangeBlockStart(result.changeBlocks, 3)).toBe(1);
    expect(DiffAlignment.Class.previousChangeBlockStart(result.changeBlocks, 1)).toBeNull();
  });

  test('identical files contain only equal rows and no change blocks', () => {
    const result = DiffAlignment.Class.align('one\ntwo\nthree', 'one\ntwo\nthree');
    expect(result.alignedRows).toEqual([
      { kind: 'equal', leftLineNumber: 1, rightLineNumber: 1 },
      { kind: 'equal', leftLineNumber: 2, rightLineNumber: 2 },
      { kind: 'equal', leftLineNumber: 3, rightLineNumber: 3 },
    ]);
    expect(result.changeBlocks).toEqual([]);
  });

  test('empty versus nonempty is a pure addition with one filler per current line', () => {
    expect(align('', 'one\ntwo')).toEqual([
      { kind: 'added', leftLineNumber: null, rightLineNumber: 1 },
      { kind: 'added', leftLineNumber: null, rightLineNumber: 2 },
    ]);
    expect(align('', '')).toEqual([]);
  });

  test('five to five hundred additive lines keeps all originals paired and creates 495 fillers', () => {
    const previousLines = ['shared one', 'shared two', 'shared three', 'shared four', 'shared five'];
    const currentLines = Array.from({ length: 500 }, (_, lineIndex) => `added ${lineIndex + 1}`);
    const pairedCurrentLineNumbers = [1, 101, 201, 301, 500];
    pairedCurrentLineNumbers.forEach((currentLineNumber, previousLineIndex) => {
      currentLines[currentLineNumber - 1] = previousLines[previousLineIndex]!;
    });

    const result = DiffAlignment.Class.align(previousLines.join('\n'), currentLines.join('\n'));
    expect(result.alignedRows).toHaveLength(500);
    expect(result.alignedRows.filter((row) => row.kind === 'added' && row.leftLineNumber === null)).toHaveLength(495);
    expect(result.alignedRows.filter((row) => row.kind === 'equal')).toEqual(
      pairedCurrentLineNumbers.map((rightLineNumber, previousLineIndex) => ({
        kind: 'equal',
        leftLineNumber: previousLineIndex + 1,
        rightLineNumber,
      })),
    );
  });
});
