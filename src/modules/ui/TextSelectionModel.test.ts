import { describe, expect, test } from 'bun:test';
import { TextSelectionModel } from './TextSelectionModel';

const model = () => new TextSelectionModel.Class();

describe('TextSelectionModel', () => {
  test('begin sets an empty span (no selection until extended)', () => {
    const selection = model();
    selection.begin({ line: 1, column: 2 });
    expect(selection.hasSelection()).toBe(false);
    selection.extend({ line: 1, column: 5 });
    expect(selection.hasSelection()).toBe(true);
  });

  test('normalized orders the ends (start ≤ end) regardless of drag direction', () => {
    const selection = model();
    selection.begin({ line: 3, column: 4 });
    selection.extend({ line: 1, column: 2 }); // dragged UP/backward
    expect(selection.normalized()).toEqual([{ line: 1, column: 2 }, { line: 3, column: 4 }]);
  });

  test('finish drops a bare click (anchor === focus)', () => {
    const selection = model();
    selection.begin({ line: 0, column: 0 });
    selection.finish();
    expect(selection.normalized()).toBeNull();
  });

  test('rangeForLine covers start (to EOL), middle (full), and end (from BOL); outside → null', () => {
    const selection = model();
    selection.begin({ line: 1, column: 3 });
    selection.extend({ line: 3, column: 4 });
    expect(selection.rangeForLine(0, 10)).toBeNull(); // above
    expect(selection.rangeForLine(1, 10)).toEqual({ start: 3, end: 10 }); // start line → to end
    expect(selection.rangeForLine(2, 8)).toEqual({ start: 0, end: 8 }); // middle → whole line
    expect(selection.rangeForLine(3, 10)).toEqual({ start: 0, end: 4 }); // end line → from start
    expect(selection.rangeForLine(4, 10)).toBeNull(); // below
  });

  test('rangeForLine on a single-line selection is the exact span', () => {
    const selection = model();
    selection.begin({ line: 2, column: 2 });
    selection.extend({ line: 2, column: 6 });
    expect(selection.rangeForLine(2, 20)).toEqual({ start: 2, end: 6 });
  });

  test('selectedText joins the covered lines (single and multi-line)', () => {
    const lines = ['first line', 'second line', 'third line'];
    const single = model();
    single.begin({ line: 0, column: 0 });
    single.extend({ line: 0, column: 5 });
    expect(single.selectedText(lines)).toBe('first');

    const multi = model();
    multi.begin({ line: 0, column: 6 });
    multi.extend({ line: 2, column: 5 });
    expect(multi.selectedText(lines)).toBe('line\nsecond line\nthird');
  });

  test('clear reports whether it removed a selection', () => {
    const selection = model();
    expect(selection.clear()).toBe(false);
    selection.begin({ line: 0, column: 0 });
    expect(selection.clear()).toBe(true);
  });
});
