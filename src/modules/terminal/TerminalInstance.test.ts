// Deterministic terminal-core coverage using the MockBackend (no real shell): scripted ANSI in,
// asserted cells out — including a color case and a cursor-move case — plus the byte round-trip and
// resize propagation through the backend seam.
import { test, expect } from 'bun:test';
import { MockBackend } from './MockBackend';
import { TerminalEmulator } from './TerminalEmulator';
import { TerminalInstance } from './TerminalInstance';

function makeInstance(columns = 20, rows = 5) {
  const backend = new MockBackend.Class();
  const emulator = new TerminalEmulator.Class(columns, rows);
  const instance = new TerminalInstance.Class(backend, emulator);
  return { backend, instance };
}

function rowText(instance: TerminalInstance.Instance, row: number): string {
  let text = '';
  for (let column = 0; column < instance.columns; column++) {
    text += instance.cell(row, column)?.characters ?? ' ';
  }
  return text.replace(/\s+$/, '');
}

test('scripted plain output renders into the cell grid', async () => {
  const { backend, instance } = makeInstance();
  backend.feed('hello');
  await instance.flush();
  expect(rowText(instance, 0)).toBe('hello');
});

test('a parsed write pulse bumps renderRevision (the repaint signal)', async () => {
  const { backend, instance } = makeInstance();
  const before = instance.renderRevision.value;
  backend.feed('x');
  await instance.flush();
  expect(instance.renderRevision.value).toBeGreaterThan(before);
});

test('SGR color renders as an RGB/palette foreground on the exact cell', async () => {
  const { backend, instance } = makeInstance();
  // ESC[31m = red foreground; write 'R' then reset.
  backend.feed('\x1b[31mR\x1b[0m');
  await instance.flush();
  const cell = instance.cell(0, 0);
  expect(cell?.characters).toBe('R');
  expect(cell?.isForegroundDefault).toBe(false);
  expect(cell?.foreground).toBe(1); // palette index 1 = red
});

test('cursor-position sequence lands text at the addressed row/column', async () => {
  const { backend, instance } = makeInstance();
  // ESC[2;3H = move to row 2, col 3 (1-based); then 'Z'.
  backend.feed('\x1b[2;3HZ');
  await instance.flush();
  expect(instance.cell(1, 2)?.characters).toBe('Z');
  expect(instance.cursorRow).toBe(1);
  expect(instance.cursorColumn).toBe(3);
});

test('viewport reads follow the scrollback base — latest lines show, not the top of scrollback', async () => {
  // Regression: after content scrolls into scrollback (baseY > 0 — e.g. a full-screen app exits),
  // the cell pull must read the VISIBLE viewport, not absolute buffer row 0. Feed 10 lines into a
  // 5-row grid: the viewport must show L5..L9, and typing (the last line) must be visible.
  const { backend, instance } = makeInstance(20, 5);
  backend.feed('L0\r\nL1\r\nL2\r\nL3\r\nL4\r\nL5\r\nL6\r\nL7\r\nL8\r\nL9');
  await instance.flush();
  expect(rowText(instance, 4)).toBe('L9'); // bottom visible line = the live/typing line
  expect(rowText(instance, 0)).toBe('L5'); // top visible line, NOT 'L0' (top of scrollback)
});

test('emulator replies (device reports) return to the child through the backend seam', async () => {
  const { backend, instance } = makeInstance();
  // ESC[6n = Device Status Report (cursor position) → the emulator replies with ESC[row;colR.
  backend.feed('\x1b[6n');
  await instance.flush();
  expect(backend.writes.some((written) => written.includes('\x1b['))).toBe(true);
});

test('sendInput crosses only the backend seam', () => {
  const { backend, instance } = makeInstance();
  instance.sendInput('ls\r');
  expect(backend.writes).toContain('ls\r');
});

test('resize drives both the emulator grid and the backend', () => {
  const { backend, instance } = makeInstance(20, 5);
  instance.resize(40, 10);
  expect(instance.columns).toBe(40);
  expect(instance.rows).toBe(10);
  expect(backend.resizes.at(-1)).toEqual({ columns: 40, rows: 10 });
});

test('exit stops input and flags the instance', () => {
  const { backend, instance } = makeInstance();
  backend.exit(0);
  expect(instance.exited.value).toBe(true);
  instance.sendInput('ignored');
  expect(backend.writes).not.toContain('ignored');
});
