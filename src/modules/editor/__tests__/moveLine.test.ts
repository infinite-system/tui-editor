// Structural line edits (move up/down + duplicate) as pure document mutations: assert the DOCUMENT and
// the cursor, plus that each op is exactly one undo step. No render layer involved.
import { test, expect, afterEach } from 'bun:test';
import { Editor } from '../Editor';
import { Clock } from '../../system/Clock';

afterEach(() => Clock.Class.freeze(null));

function openWith(text: string): Editor.Instance {
  const editor = new Editor.Class();
  editor.document.loadFromText(text, 'test.ts');
  editor.hasDocument.value = true;
  editor.cursor.set(0, 0);
  return editor;
}

const lines = (editor: Editor.Instance): string[] =>
  Array.from({ length: editor.document.lineCount }, (_unused, index) => editor.document.line(index));

test('moveLineDown swaps with the line below and the cursor follows the line', () => {
  const editor = openWith('one\ntwo\nthree');
  editor.cursor.set(0, 2); // on "one"
  editor.moveLineDown();
  expect(lines(editor)).toEqual(['two', 'one', 'three']);
  expect(editor.cursor.line.value).toBe(1); // cursor followed "one" down
  expect(editor.cursor.col.value).toBe(2); // same column
});

test('moveLineUp swaps with the line above and the cursor follows', () => {
  const editor = openWith('one\ntwo\nthree');
  editor.cursor.set(2, 1); // on "three"
  editor.moveLineUp();
  expect(lines(editor)).toEqual(['one', 'three', 'two']);
  expect(editor.cursor.line.value).toBe(1);
  expect(editor.cursor.col.value).toBe(1);
});

test('moveLineUp at the top edge is a no-op (document + cursor unchanged)', () => {
  const editor = openWith('one\ntwo');
  editor.cursor.set(0, 1);
  editor.moveLineUp();
  expect(lines(editor)).toEqual(['one', 'two']);
  expect(editor.cursor.line.value).toBe(0);
  editor.performUndo(); // the no-op recorded nothing → undo has nothing to revert here
  expect(lines(editor)).toEqual(['one', 'two']);
});

test('moveLineDown at the bottom edge is a no-op', () => {
  const editor = openWith('one\ntwo');
  editor.cursor.set(1, 0); // last line
  editor.moveLineDown();
  expect(lines(editor)).toEqual(['one', 'two']);
  expect(editor.cursor.line.value).toBe(1);
});

test('repeated moveLineDown walks the line down and the cursor tracks it', () => {
  const editor = openWith('a\nb\nc\nd');
  editor.cursor.set(0, 0); // on "a"
  editor.moveLineDown();
  editor.moveLineDown();
  expect(lines(editor)).toEqual(['b', 'c', 'a', 'd']);
  expect(editor.cursor.line.value).toBe(2); // "a" walked to index 2
});

test('duplicateLine inserts a copy directly below and moves the cursor onto the copy', () => {
  const editor = openWith('alpha\nbeta');
  editor.cursor.set(0, 3); // on "alpha"
  editor.duplicateLine();
  expect(lines(editor)).toEqual(['alpha', 'alpha', 'beta']);
  expect(editor.cursor.line.value).toBe(1); // cursor on the copy
  expect(editor.cursor.col.value).toBe(3);
});

test('one performUndo reverts a moveLineDown entirely', () => {
  const editor = openWith('one\ntwo\nthree');
  editor.cursor.set(0, 0);
  editor.moveLineDown();
  expect(lines(editor)).toEqual(['two', 'one', 'three']);
  editor.performUndo();
  expect(lines(editor)).toEqual(['one', 'two', 'three']); // restored in ONE step
  expect(editor.cursor.line.value).toBe(0); // cursor restored too
});

test('one performUndo reverts a duplicateLine entirely', () => {
  const editor = openWith('alpha\nbeta');
  editor.cursor.set(0, 0);
  editor.duplicateLine();
  expect(editor.document.lineCount).toBe(3);
  editor.performUndo();
  expect(lines(editor)).toEqual(['alpha', 'beta']); // the copy removed in one undo
  expect(editor.document.lineCount).toBe(2);
});

test('the cursor column clamps to the moved line when it is shorter', () => {
  const editor = openWith('longline\nx'); // "x" is shorter than the cursor column
  editor.cursor.set(0, 7); // deep into "longline"
  editor.moveLineDown();
  expect(lines(editor)).toEqual(['x', 'longline']);
  expect(editor.cursor.line.value).toBe(1); // followed "longline" down
  expect(editor.cursor.col.value).toBe(7); // still valid on "longline"
});
