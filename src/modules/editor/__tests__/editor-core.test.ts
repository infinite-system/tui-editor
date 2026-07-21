import { test, expect } from 'bun:test';
import { TextDocument } from '../TextDocument';
import { Viewport } from '../Viewport';
import { Editor } from '../Editor';

test('TextDocument splits text into lines and stamps a revision', () => {
  const d = new TextDocument.Class();
  const r0 = d.revision.value;
  d.loadFromText('a\nb\nc');
  expect(d.lineCount).toBe(3);
  expect(d.line(1)).toBe('b');
  expect(d.revision.value).toBeGreaterThan(r0);
  expect(d.dirty.value).toBe(false);
});

test('TextDocument.slice returns only the requested window (flyweight read)', () => {
  const d = new TextDocument.Class();
  d.loadFromText(Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n'));
  const win = d.slice(500, 5);
  expect(win).toEqual(['line 500', 'line 501', 'line 502', 'line 503', 'line 504']);
});

test('TextDocument mutation marks dirty and bumps revision', () => {
  const d = new TextDocument.Class();
  d.loadFromText('x');
  const r = d.revision.value;
  d.setLine(0, 'y');
  expect(d.line(0)).toBe('y');
  expect(d.dirty.value).toBe(true);
  expect(d.revision.value).toBeGreaterThan(r);
  d.markSaved();
  expect(d.dirty.value).toBe(false);
});

test('Viewport keeps a target line within the window', () => {
  const v = new Viewport.Class();
  v.setSize(80, 10);
  v.scrollToLine(50, 100);
  expect(v.firstVisible).toBeLessThanOrEqual(50);
  expect(v.firstVisible + 10).toBeGreaterThan(50);
  v.scrollToLine(0, 100);
  expect(v.firstVisible).toBe(0);
});

test('Viewport never scrolls past the last page', () => {
  const v = new Viewport.Class();
  v.setSize(80, 10);
  v.scrollBy(1000, 30);
  expect(v.firstVisible).toBe(20); // 30 - 10
});

test('Editor vertical movement clamps and preserves goal column', () => {
  const e = new Editor.Class();
  e.document.loadFromText(['long line here', 'ab', 'another long line'].join('\n'));
  e.hasDocument.value = true;
  e.cursor.set(0, 12);
  e.moveVertical(1); // to short line 'ab' (len 2)
  expect(e.cursor.line.value).toBe(1);
  expect(e.cursor.col.value).toBe(2); // clamped to line length
  e.moveVertical(1); // to long line — goal column restored
  expect(e.cursor.line.value).toBe(2);
  expect(e.cursor.col.value).toBe(12);
});

test('Editor horizontal movement wraps across line boundaries', () => {
  const e = new Editor.Class();
  e.document.loadFromText('ab\ncd');
  e.hasDocument.value = true;
  e.cursor.set(0, 2); // end of first line
  e.moveHorizontal(1); // wrap to start of next line
  expect(e.cursor.line.value).toBe(1);
  expect(e.cursor.col.value).toBe(0);
  e.moveHorizontal(-1); // wrap back to end of first line
  expect(e.cursor.line.value).toBe(0);
  expect(e.cursor.col.value).toBe(2);
});
