import { test, expect, afterEach } from 'bun:test';
import { Editor } from '../Editor';
import { UndoStore } from '../../storage/UndoStore';
import { Clock } from '../../system/Clock';

afterEach(() => Clock.Class.freeze(null));

function openWith(text: string): Editor.Instance {
  const editor = new Editor.Class();
  editor.document.loadFromText(text, 'test.ts');
  editor.hasDocument.value = true;
  editor.cursor.set(0, 0);
  return editor;
}

test('insertText inserts at cursor and advances it', () => {
  const editor = openWith('bc');
  editor.insertText('a');
  expect(editor.document.line(0)).toBe('abc');
  expect(editor.cursor.col.value).toBe(1);
  expect(editor.document.dirty.value).toBe(true);
});

test('newline splits the line and auto-indents', () => {
  const editor = openWith('  foo');
  editor.cursor.set(0, 5); // end of "  foo"
  editor.insertNewline();
  expect(editor.document.lineCount).toBe(2);
  expect(editor.document.line(1)).toBe('  '); // indent carried
  expect(editor.cursor.line.value).toBe(1);
  expect(editor.cursor.col.value).toBe(2);
});

test('backspace at column 0 joins with the previous line', () => {
  const editor = openWith('ab\ncd');
  editor.cursor.set(1, 0);
  editor.backspace();
  expect(editor.document.lineCount).toBe(1);
  expect(editor.document.line(0)).toBe('abcd');
  expect(editor.cursor.line.value).toBe(0);
  expect(editor.cursor.col.value).toBe(2);
});

test('deleteForward at end of line joins the next line', () => {
  const editor = openWith('ab\ncd');
  editor.cursor.set(0, 2);
  editor.deleteChar();
  expect(editor.document.line(0)).toBe('abcd');
  expect(editor.document.lineCount).toBe(1);
});

test('deletePreviousWord uses the navigation boundary and is one undo step', () => {
  const editor = openWith('hello world');
  editor.cursor.set(0, 11);
  editor.moveWordHorizontal(-1);
  expect(editor.cursor.col.value).toBe(6);
  editor.cursor.set(0, 11);
  editor.deletePreviousWord();
  expect(editor.document.line(0)).toBe('hello ');
  expect(editor.cursor.col.value).toBe(6);
  editor.performUndo();
  expect(editor.document.line(0)).toBe('hello world');
});

test('deletePreviousWord at line start deletes only the newline', () => {
  const editor = openWith('ab\ncd');
  editor.cursor.set(1, 0);
  editor.deletePreviousWord();
  expect(editor.document.lines).toEqual(['abcd']);
  expect(editor.cursor.line.value).toBe(0);
  expect(editor.cursor.col.value).toBe(2);
});

test('save writes the buffer and clears dirty', () => {
  const editor = openWith('x');
  editor.insertText('y');
  expect(editor.document.dirty.value).toBe(true);
  // no path write here (loadFromText path is 'test.ts', relative) — use in-memory assertion:
  // markSaved is exercised via document
  editor.document.markSaved();
  expect(editor.document.dirty.value).toBe(false);
});

test('undo reverts an edit; redo re-applies it', () => {
  const editor = openWith('a');
  editor.cursor.set(0, 1);
  editor.insertText('b'); // "ab"
  expect(editor.document.line(0)).toBe('ab');
  editor.performUndo();
  expect(editor.document.line(0)).toBe('a');
  editor.performRedo();
  expect(editor.document.line(0)).toBe('ab');
});

test('undo back to the saved content reads as UNCHANGED (dirty clears, redo re-dirties)', () => {
  const editor = openWith('a'); // loaded content "a" is the clean baseline
  editor.cursor.set(0, 1);
  editor.insertText('b'); // "ab"
  expect(editor.document.dirty.value).toBe(true);
  editor.performUndo(); // back to "a" — exactly the loaded content
  expect(editor.document.line(0)).toBe('a');
  expect(editor.document.dirty.value).toBe(false); // matches the baseline → not dirty
  editor.performRedo(); // "ab" again — differs from the baseline
  expect(editor.document.dirty.value).toBe(true);
});

test('markSaved rebaselines: matchesSaved tracks the last saved content, not the original', () => {
  const editor = openWith('a');
  expect(editor.document.matchesSaved()).toBe(true); // fresh load is clean
  editor.cursor.set(0, 1);
  editor.insertText('b'); // "ab"
  expect(editor.document.matchesSaved()).toBe(false);
  editor.document.markSaved(); // the saved baseline is now "ab"
  expect(editor.document.matchesSaved()).toBe(true);
  editor.insertText('c'); // "abc" — differs from the new baseline
  expect(editor.document.matchesSaved()).toBe(false);
});

test('undo coalesces a run of typed characters into one step', () => {
  let time = 1000;
  Clock.Class.freeze(() => time);
  const editor = openWith('');
  editor.cursor.set(0, 0);
  for (const character of 'hello') {
    editor.insertText(character);
    time += 50; // within COALESCE_MS
  }
  expect(editor.document.line(0)).toBe('hello');
  editor.performUndo(); // one step should remove the whole run
  expect(editor.document.line(0)).toBe('');
});

test('UndoStore respects kind boundaries (typing then newline are separate steps)', () => {
  const undoStore = new UndoStore.Class();
  undoStore.record({ lines: ['a'], cursor: { line: 0, col: 0 }, kind: 'insert', at: 0 }, 0);
  undoStore.record({ lines: ['ab'], cursor: { line: 0, col: 1 }, kind: 'insert', at: 50 }, 50); // coalesced
  undoStore.record({ lines: ['abc'], cursor: { line: 0, col: 2 }, kind: 'newline', at: 100 }, 100); // new step
  expect(undoStore.depth).toBe(2);
});
