// Selection model + selection-aware editing + clipboard.
// Covers the editor invariant "Selection is an anchor plus the cursor and edits replace it".
import { test, expect } from 'bun:test';
import { Cursor } from '../Cursor';
import { TextDocument } from '../TextDocument';
import { Editor } from '../Editor';
import { Clipboard } from '../../system/Clipboard';

function editorWith(text: string): any {
  const editor = new Editor.Class() as any;
  editor.document.loadFromText(text);
  editor.hasDocument.value = true;
  return editor;
}

test('cursor selection range normalizes anchor/cursor order', () => {
  const cursor = new Cursor.Class() as any;
  cursor.set(2, 3);
  cursor.setAnchorHere();
  cursor.set(1, 0); // cursor now before the anchor
  expect(cursor.hasSelection).toBe(true);
  const range = cursor.selectionRange();
  expect(range.start).toEqual({ line: 1, col: 0 });
  expect(range.end).toEqual({ line: 2, col: 3 });
  cursor.set(2, 3); // back onto the anchor → empty
  expect(cursor.hasSelection).toBe(false);
  expect(cursor.selectionRange()).toBeNull();
});

test('sliceRange / deleteRange / insertMultiline are grapheme-correct and multi-line', () => {
  const document = new TextDocument.Class() as any;
  document.loadFromText('a😀b\ncd\nef');
  expect(document.sliceRange({ line: 0, col: 1 }, { line: 0, col: 2 })).toBe('😀');
  expect(document.sliceRange({ line: 0, col: 2 }, { line: 2, col: 1 })).toBe('b\ncd\ne');
  const position = document.deleteRange({ line: 0, col: 1 }, { line: 1, col: 1 });
  expect(document.line(0)).toBe('ad');
  expect(position).toEqual({ line: 0, col: 1 });

  const secondDocument = new TextDocument.Class() as any;
  secondDocument.loadFromText('xy');
  const end = secondDocument.insertMultiline(0, 1, 'A\nB');
  expect(secondDocument.line(0)).toBe('xA');
  expect(secondDocument.line(1)).toBe('By');
  expect(end).toEqual({ line: 1, col: 1 });
});

test('typing over a selection replaces it', () => {
  const editor = editorWith('hello');
  editor.cursor.set(0, 1);
  editor.cursor.setAnchorHere();
  editor.cursor.set(0, 4); // select "ell"
  editor.insertText('X');
  expect(editor.document.line(0)).toBe('hXo');
  expect(editor.hasSelection).toBe(false);
});

test('backspace deletes the selection', () => {
  const editor = editorWith('abcdef');
  editor.cursor.set(0, 2);
  editor.cursor.setAnchorHere();
  editor.cursor.set(0, 5); // select "cde"
  editor.backspace();
  expect(editor.document.line(0)).toBe('abf');
});

test('deletePreviousWord deletes an active selection instead of a word', () => {
  const editor = editorWith('one two three');
  editor.cursor.set(0, 4);
  editor.cursor.setAnchorHere();
  editor.cursor.set(0, 7);
  editor.deletePreviousWord();
  expect(editor.document.line(0)).toBe('one  three');
  expect(editor.cursor.col.value).toBe(4);
  expect(editor.hasSelection).toBe(false);
});

test('selectAll + selectionText spans the document', () => {
  const editor = editorWith('one\ntwo');
  editor.selectAll();
  expect(editor.hasSelection).toBe(true);
  expect(editor.selectionText()).toBe('one\ntwo');
});

test('cut copies the selection then deletes it', async () => {
  const editor = editorWith('abcdef');
  let copied = '';
  Object.defineProperty(Clipboard.Class, 'copy', {
    value: async (text: string) => {
      copied = text;
      return true;
    },
    configurable: true,
    writable: true,
  });
  editor.cursor.set(0, 1);
  editor.cursor.setAnchorHere();
  editor.cursor.set(0, 4); // select "bcd"
  await editor.cutSelection();
  expect(copied).toBe('bcd');
  expect(editor.document.line(0)).toBe('aef');
});

test('paste inserts multi-line clipboard text, replacing any selection', async () => {
  const editor = editorWith('AB');
  Object.defineProperty(Clipboard.Class, 'paste', {
    value: async () => 'x\ny',
    configurable: true,
    writable: true,
  });
  editor.cursor.set(0, 1);
  await editor.pasteClipboard();
  expect(editor.document.line(0)).toBe('Ax');
  expect(editor.document.line(1)).toBe('yB');
});
