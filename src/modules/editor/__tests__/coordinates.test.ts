// Unicode coordinate matrix + grapheme-safe editing.
// Covers the editor invariant "A cursor position resolves to three distinct coordinates".
import { test, expect } from 'bun:test';
import {
  graphemeCount,
  graphemeToU16,
  u16ToGrapheme,
  displayColumn,
  graphemeWidth,
  lineWidth,
  graphemeAtDisplayColumn,
} from '../editor.coordinates';
import { TextDocument } from '../TextDocument';

test('grapheme count treats emoji and combining marks as one character', () => {
  expect(graphemeCount('abc')).toBe(3);
  expect(graphemeCount('a😀b')).toBe(3); // emoji is one grapheme (two UTF-16 units)
  expect(graphemeCount('é')).toBe(1); // e + combining acute = one cluster
  expect(graphemeCount('')).toBe(0);
  expect('a😀b'.length).toBe(4); // sanity: UTF-16 length differs from grapheme count
});

test('grapheme <-> UTF-16 mapping', () => {
  expect(graphemeToU16('a😀b', 0)).toBe(0);
  expect(graphemeToU16('a😀b', 1)).toBe(1);
  expect(graphemeToU16('a😀b', 2)).toBe(3); // after 'a'(1) + emoji(2)
  expect(graphemeToU16('a😀b', 3)).toBe(4);
  expect(u16ToGrapheme('a😀b', 3)).toBe(2);
  expect(u16ToGrapheme('a😀b', 1)).toBe(1);
});

test('display column: wide chars, combining marks, and tabs', () => {
  expect(graphemeWidth('中')).toBe(2);
  expect(displayColumn('中x', 1)).toBe(2);
  expect(displayColumn('中x', 2)).toBe(3);
  expect(displayColumn('áb', 1)).toBe(1); // combining adds no width
  expect(displayColumn('áb', 2)).toBe(2);
  expect(displayColumn('\tx', 1, 4)).toBe(4); // tab to next stop
  expect(displayColumn('ab\tx', 3, 4)).toBe(4);
  expect(lineWidth('中\tx', 4)).toBe(5); // 中(2) then tab to col 4, then x -> 5
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
  for (let graphemeIndex = 0; graphemeIndex <= graphemeCount(line); graphemeIndex++) {
    expect(graphemeAtDisplayColumn(line, displayColumn(line, graphemeIndex))).toBe(graphemeIndex);
  }
});

test('graphemeAtDisplayColumn: a hit inside a wide glyph resolves to that glyph', () => {
  const line = 'a中b'; // cells: a=0, 中=1..2 (wide), b=3
  expect(graphemeAtDisplayColumn(line, 0)).toBe(0); // on 'a'
  expect(graphemeAtDisplayColumn(line, 1)).toBe(1); // left cell of 中
  expect(graphemeAtDisplayColumn(line, 2)).toBe(1); // right cell of 中 -> still 中
  expect(graphemeAtDisplayColumn(line, 3)).toBe(2); // on 'b'
});

test('graphemeAtDisplayColumn: a hit inside a tab resolves to the tab', () => {
  const line = '\ta'; // tab covers cells 0..3 (tabWidth 4), 'a' at cell 4
  expect(graphemeAtDisplayColumn(line, 0)).toBe(0);
  expect(graphemeAtDisplayColumn(line, 3)).toBe(0); // still inside the tab
  expect(graphemeAtDisplayColumn(line, 4)).toBe(1); // on 'a'
});

test('graphemeAtDisplayColumn clamps past end-of-line and below zero', () => {
  expect(graphemeAtDisplayColumn('ab', 99)).toBe(2); // caret after the last char
  expect(graphemeAtDisplayColumn('ab', -5)).toBe(0);
});
