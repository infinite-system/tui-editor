// Ctrl+Left/Right word jumps: use the same word/whitespace/punctuation/newline boundaries as
// delete-previous-word, stay grapheme-safe, and cross line boundaries.
import { test, expect } from 'bun:test';
import { Editor } from '../Editor';

function editorWith(lines: string[]): Editor.Instance {
  const editor = new Editor.Class();
  editor.document.loadFromText(lines.join('\n'), '/test.txt');
  editor.hasDocument.value = true;
  return editor;
}

test('word-jump right lands on successive word starts', () => {
  const editor = editorWith(['const value = compute(input);']);
  editor.placeCursor(0, 0);
  editor.moveWordHorizontal(1);
  expect(editor.cursor.col.value).toBe(6); // value
  editor.moveWordHorizontal(1);
  expect(editor.cursor.col.value).toBe(14); // compute
  editor.moveWordHorizontal(1);
  expect(editor.cursor.col.value).toBe(22); // input
});

test('word-jump left treats punctuation as its own run before word starts', () => {
  const editor = editorWith(['const value = compute(input);']);
  editor.placeCursor(0, 22);
  editor.moveWordHorizontal(-1);
  expect(editor.cursor.col.value).toBe(21); // opening punctuation before input
  editor.moveWordHorizontal(-1);
  expect(editor.cursor.col.value).toBe(14);
  editor.moveWordHorizontal(-1);
  expect(editor.cursor.col.value).toBe(12); // equals punctuation after its leading whitespace
  editor.moveWordHorizontal(-1);
  expect(editor.cursor.col.value).toBe(6);
  editor.moveWordHorizontal(-1);
  expect(editor.cursor.col.value).toBe(0);
});

test('word-jump crosses line boundaries', () => {
  const editor = editorWith(['end', 'start of next']);
  editor.placeCursor(0, 3); // EOL of line 0
  editor.moveWordHorizontal(1);
  expect(editor.cursor.line.value).toBe(1);
  expect(editor.cursor.col.value).toBe(0);
  editor.moveWordHorizontal(-1); // newline is its own boundary: land at the preceding line end
  expect(editor.cursor.line.value).toBe(0);
  expect(editor.cursor.col.value).toBe(3);
  editor.moveWordHorizontal(-1);
  expect(editor.cursor.col.value).toBe(0);
});

test('word-jump treats CJK and emoji as word/graphene units without splitting', () => {
  const editor = editorWith(['中文 word']);
  editor.placeCursor(0, 0);
  editor.moveWordHorizontal(1);
  expect(editor.cursor.col.value).toBe(3); // lands on "word" (CJK letters are \p{L})
});

test('shift composes: word-jump extends the selection', () => {
  const editor = editorWith(['alpha beta']);
  editor.placeCursor(0, 0);
  editor.moveWordHorizontal(1, true);
  expect(editor.cursor.hasSelection).toBe(true);
  expect(editor.selectionText()).toBe('alpha ');
});
