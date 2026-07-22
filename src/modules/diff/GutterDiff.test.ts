import { describe, expect, test } from 'bun:test';
import { GutterDiff } from './GutterDiff';

describe('GutterDiff', () => {
  test('equal text has no gutter statuses', () => {
    expect(GutterDiff.Class.statusByLine('one\ntwo', 'one\ntwo')).toEqual(new Map());
  });

  test('a replaced line is modified', () => {
    expect(GutterDiff.Class.statusByLine('one\nold\nthree', 'one\nnew\nthree')).toEqual(
      new Map([[1, 'modified']]),
    );
  });

  test('an inserted line is added', () => {
    expect(GutterDiff.Class.statusByLine('one\nthree', 'one\ntwo\nthree')).toEqual(
      new Map([[1, 'added']]),
    );
  });

  test('a deleted run marks the following buffer line', () => {
    expect(
      GutterDiff.Class.statusByLine(
        'one\nremoved one\nremoved two\nfour',
        'one\nfour',
      ),
    ).toEqual(new Map([[1, 'deleted']]));
  });

  test('an untracked file marks every buffer line as added', () => {
    expect(GutterDiff.Class.statusByLine('', 'one\ntwo\nthree')).toEqual(
      new Map([
        [0, 'added'],
        [1, 'added'],
        [2, 'added'],
      ]),
    );
  });

  test('a deletion at end of file marks the last buffer line', () => {
    expect(GutterDiff.Class.statusByLine('one\ntwo\nremoved', 'one\ntwo')).toEqual(
      new Map([[1, 'deleted']]),
    );
  });
});
