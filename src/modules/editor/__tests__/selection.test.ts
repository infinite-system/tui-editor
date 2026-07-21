// Selection model + selection-aware editing + clipboard.
// Covers the editor invariant "Selection is an anchor plus the cursor and edits replace it".
import { test, expect } from 'bun:test';
import { Cursor } from '../Cursor';
import { TextDocument } from '../TextDocument';
import { Editor } from '../Editor';
import { Clipboard } from '../../system/Clipboard';

function editorWith(text: string): any {
  const ed = new Editor.Class() as any;
  ed.document.loadFromText(text);
  ed.hasDocument.value = true;
  return ed;
}

test('cursor selection range normalizes anchor/cursor order', () => {
  const c = new Cursor.Class() as any;
  c.set(2, 3);
  c.setAnchorHere();
  c.set(1, 0); // cursor now before the anchor
  expect(c.hasSelection).toBe(true);
  const r = c.selectionRange();
  expect(r.start).toEqual({ line: 1, col: 0 });
  expect(r.end).toEqual({ line: 2, col: 3 });
  c.set(2, 3); // back onto the anchor → empty
  expect(c.hasSelection).toBe(false);
  expect(c.selectionRange()).toBeNull();
});

test('sliceRange / deleteRange / insertMultiline are grapheme-correct and multi-line', () => {
  const d = new TextDocument.Class() as any;
  d.loadFromText('a😀b\ncd\nef');
  expect(d.sliceRange({ line: 0, col: 1 }, { line: 0, col: 2 })).toBe('😀');
  expect(d.sliceRange({ line: 0, col: 2 }, { line: 2, col: 1 })).toBe('b\ncd\ne');
  const pos = d.deleteRange({ line: 0, col: 1 }, { line: 1, col: 1 });
  expect(d.line(0)).toBe('ad');
  expect(pos).toEqual({ line: 0, col: 1 });

  const d2 = new TextDocument.Class() as any;
  d2.loadFromText('xy');
  const end = d2.insertMultiline(0, 1, 'A\nB');
  expect(d2.line(0)).toBe('xA');
  expect(d2.line(1)).toBe('By');
  expect(end).toEqual({ line: 1, col: 1 });
});

test('typing over a selection replaces it', () => {
  const ed = editorWith('hello');
  ed.cursor.set(0, 1);
  ed.cursor.setAnchorHere();
  ed.cursor.set(0, 4); // select "ell"
  ed.insertText('X');
  expect(ed.document.line(0)).toBe('hXo');
  expect(ed.hasSelection).toBe(false);
});

test('backspace deletes the selection', () => {
  const ed = editorWith('abcdef');
  ed.cursor.set(0, 2);
  ed.cursor.setAnchorHere();
  ed.cursor.set(0, 5); // select "cde"
  ed.backspace();
  expect(ed.document.line(0)).toBe('abf');
});

test('selectAll + selectionText spans the document', () => {
  const ed = editorWith('one\ntwo');
  ed.selectAll();
  expect(ed.hasSelection).toBe(true);
  expect(ed.selectionText()).toBe('one\ntwo');
});

test('cut copies the selection then deletes it', async () => {
  const ed = editorWith('abcdef');
  let copied = '';
  Object.defineProperty(Clipboard.Class, 'copy', {
    value: async (t: string) => {
      copied = t;
      return true;
    },
    configurable: true,
    writable: true,
  });
  ed.cursor.set(0, 1);
  ed.cursor.setAnchorHere();
  ed.cursor.set(0, 4); // select "bcd"
  await ed.cutSelection();
  expect(copied).toBe('bcd');
  expect(ed.document.line(0)).toBe('aef');
});

test('paste inserts multi-line clipboard text, replacing any selection', async () => {
  const ed = editorWith('AB');
  Object.defineProperty(Clipboard.Class, 'paste', {
    value: async () => 'x\ny',
    configurable: true,
    writable: true,
  });
  ed.cursor.set(0, 1);
  await ed.pasteClipboard();
  expect(ed.document.line(0)).toBe('Ax');
  expect(ed.document.line(1)).toBe('yB');
});
