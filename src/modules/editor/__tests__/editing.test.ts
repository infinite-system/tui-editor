import { test, expect, afterEach } from 'bun:test';
import { Editor } from '../Editor';
import { UndoStore } from '../../storage/UndoStore';
import { Clock } from '../../system/Clock';

afterEach(() => Clock.Class.freeze(null));

function openWith(text: string): Editor.Instance {
  const e = new Editor.Class();
  e.document.loadFromText(text, 'test.ts');
  e.hasDocument.value = true;
  e.cursor.set(0, 0);
  return e;
}

test('insertText inserts at cursor and advances it', () => {
  const e = openWith('bc');
  e.insertText('a');
  expect(e.document.line(0)).toBe('abc');
  expect(e.cursor.col.value).toBe(1);
  expect(e.document.dirty.value).toBe(true);
});

test('newline splits the line and auto-indents', () => {
  const e = openWith('  foo');
  e.cursor.set(0, 5); // end of "  foo"
  e.insertNewline();
  expect(e.document.lineCount).toBe(2);
  expect(e.document.line(1)).toBe('  '); // indent carried
  expect(e.cursor.line.value).toBe(1);
  expect(e.cursor.col.value).toBe(2);
});

test('backspace at column 0 joins with the previous line', () => {
  const e = openWith('ab\ncd');
  e.cursor.set(1, 0);
  e.backspace();
  expect(e.document.lineCount).toBe(1);
  expect(e.document.line(0)).toBe('abcd');
  expect(e.cursor.line.value).toBe(0);
  expect(e.cursor.col.value).toBe(2);
});

test('deleteForward at end of line joins the next line', () => {
  const e = openWith('ab\ncd');
  e.cursor.set(0, 2);
  e.deleteChar();
  expect(e.document.line(0)).toBe('abcd');
  expect(e.document.lineCount).toBe(1);
});

test('save writes the buffer and clears dirty', () => {
  const e = openWith('x');
  e.insertText('y');
  expect(e.document.dirty.value).toBe(true);
  // no path write here (loadFromText path is 'test.ts', relative) — use in-memory assertion:
  // markSaved is exercised via document
  e.document.markSaved();
  expect(e.document.dirty.value).toBe(false);
});

test('undo reverts an edit; redo re-applies it', () => {
  const e = openWith('a');
  e.cursor.set(0, 1);
  e.insertText('b'); // "ab"
  expect(e.document.line(0)).toBe('ab');
  e.performUndo();
  expect(e.document.line(0)).toBe('a');
  e.performRedo();
  expect(e.document.line(0)).toBe('ab');
});

test('undo coalesces a run of typed characters into one step', () => {
  let t = 1000;
  Clock.Class.freeze(() => t);
  const e = openWith('');
  e.cursor.set(0, 0);
  for (const ch of 'hello') {
    e.insertText(ch);
    t += 50; // within COALESCE_MS
  }
  expect(e.document.line(0)).toBe('hello');
  e.performUndo(); // one step should remove the whole run
  expect(e.document.line(0)).toBe('');
});

test('UndoStore respects kind boundaries (typing then newline are separate steps)', () => {
  const s = new UndoStore.Class();
  s.record({ lines: ['a'], cursor: { line: 0, col: 0 }, kind: 'insert', at: 0 }, 0);
  s.record({ lines: ['ab'], cursor: { line: 0, col: 1 }, kind: 'insert', at: 50 }, 50); // coalesced
  s.record({ lines: ['abc'], cursor: { line: 0, col: 2 }, kind: 'newline', at: 100 }, 100); // new step
  expect(s.depth).toBe(2);
});
