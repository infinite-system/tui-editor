import { test, expect } from 'bun:test';
import { TextDocument } from '../TextDocument';
import { Viewport } from '../Viewport';
import { Editor } from '../Editor';

test('TextDocument splits text into lines and stamps a revision', () => {
  const document = new TextDocument.Class();
  const revisionBefore = document.revision.value;
  document.loadFromText('a\nb\nc');
  expect(document.lineCount).toBe(3);
  expect(document.line(1)).toBe('b');
  expect(document.revision.value).toBeGreaterThan(revisionBefore);
  expect(document.dirty.value).toBe(false);
});

test('TextDocument.slice returns only the requested window (flyweight read)', () => {
  const document = new TextDocument.Class();
  document.loadFromText(Array.from({ length: 1000 }, (_, index) => `line ${index}`).join('\n'));
  const window = document.slice(500, 5);
  expect(window).toEqual(['line 500', 'line 501', 'line 502', 'line 503', 'line 504']);
});

test('TextDocument mutation marks dirty and bumps revision', () => {
  const document = new TextDocument.Class();
  document.loadFromText('x');
  const revisionBefore = document.revision.value;
  document.setLine(0, 'y');
  expect(document.line(0)).toBe('y');
  expect(document.dirty.value).toBe(true);
  expect(document.revision.value).toBeGreaterThan(revisionBefore);
  document.markSaved();
  expect(document.dirty.value).toBe(false);
});

test('Viewport keeps a target line within the window', () => {
  const viewport = new Viewport.Class();
  viewport.setSize(80, 10);
  viewport.scrollToLine(50, 100);
  expect(viewport.firstVisible).toBeLessThanOrEqual(50);
  expect(viewport.firstVisible + 10).toBeGreaterThan(50);
  viewport.scrollToLine(0, 100);
  expect(viewport.firstVisible).toBe(0);
});

test('Viewport never scrolls past the last page', () => {
  const viewport = new Viewport.Class();
  viewport.setSize(80, 10);
  viewport.scrollBy(1000, 30);
  expect(viewport.firstVisible).toBe(20); // 30 - 10
});

test('Editor vertical movement clamps and preserves goal column', () => {
  const editor = new Editor.Class();
  editor.document.loadFromText(['long line here', 'ab', 'another long line'].join('\n'));
  editor.hasDocument.value = true;
  editor.cursor.set(0, 12);
  editor.moveVertical(1); // to short line 'ab' (len 2)
  expect(editor.cursor.line.value).toBe(1);
  expect(editor.cursor.col.value).toBe(2); // clamped to line length
  editor.moveVertical(1); // to long line — goal column restored
  expect(editor.cursor.line.value).toBe(2);
  expect(editor.cursor.col.value).toBe(12);
});

test('Editor horizontal movement wraps across line boundaries', () => {
  const editor = new Editor.Class();
  editor.document.loadFromText('ab\ncd');
  editor.hasDocument.value = true;
  editor.cursor.set(0, 2); // end of first line
  editor.moveHorizontal(1); // wrap to start of next line
  expect(editor.cursor.line.value).toBe(1);
  expect(editor.cursor.col.value).toBe(0);
  editor.moveHorizontal(-1); // wrap back to end of first line
  expect(editor.cursor.line.value).toBe(0);
  expect(editor.cursor.col.value).toBe(2);
});
