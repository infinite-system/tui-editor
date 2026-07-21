// Goal column preserves the DISPLAY column (visual x) across vertical moves — the goal survives
// whole up/down runs; only each landing clamps to shorter lines (human-QA regression).
import { test, expect } from 'bun:test';
import { Editor } from '../Editor';

function editorWith(lines: string[]): Editor.Instance {
  const editor = new Editor.Class();
  editor.document.loadFromText(lines.join('\n'), '/test.txt');
  editor.hasDocument.value = true;
  return editor;
}

test('goal survives an up/down run across a short line', () => {
  const editor = editorWith(['abcdefgh', 'ab', 'abcdefgh']);
  editor.placeCursor(0, 6);
  editor.moveVertical(1); // short line clamps the landing...
  expect(editor.cursor.col.value).toBe(2);
  editor.moveVertical(1); // ...but the goal survives the run
  expect(editor.cursor.col.value).toBe(6);
  editor.moveVertical(-2); // and back up
  expect(editor.cursor.col.value).toBe(6);
});

test('vertical moves preserve the DISPLAY column across a wide-glyph line', () => {
  const editor = editorWith(['abcdef', '中文字', 'abcdef']);
  editor.placeCursor(0, 4); // display column 4
  editor.moveVertical(1);
  // display 4 on "中文字" (widths 2,2,2): grapheme 2 starts at display 4 -> lands on 字
  expect(editor.cursor.col.value).toBe(2);
  editor.moveVertical(1);
  expect(editor.cursor.col.value).toBe(4); // back to display 4 on ASCII
});

test('vertical moves preserve the DISPLAY column across a tab line', () => {
  const editor = editorWith(['abcdefgh', '\tx', 'abcdefgh']);
  editor.placeCursor(0, 5); // display column 5
  editor.moveVertical(1);
  // "\tx": tab covers display 0..3, x at display 4 (grapheme 1); display 5 is past EOL -> clamp to 2
  expect(editor.cursor.col.value).toBe(2);
  editor.moveVertical(1);
  expect(editor.cursor.col.value).toBe(5); // display goal 5 restored
});

test('a horizontal move rebases the goal', () => {
  const editor = editorWith(['abcdefgh', 'abcdefgh']);
  editor.placeCursor(0, 6);
  editor.moveHorizontal(-3); // col 3 -> new goal display 3
  editor.moveVertical(1);
  expect(editor.cursor.col.value).toBe(3);
});
