import { describe, expect, test } from 'bun:test';
import { AgentComposer, COMPOSER_MAX_ROWS, COMPOSER_GUTTER_COLUMNS } from './AgentComposer';

const composer = () => new AgentComposer.Class();

describe('AgentComposer — wrap, cap, caret', () => {
  test('an empty composer is one row with the caret just after the prompt gutter', () => {
    const layout = composer().layout(40);
    expect(layout.rowCount).toBe(1);
    expect(layout.rows[0]?.isFirstLine).toBe(true);
    expect(layout.caretRow).toBe(0);
    expect(layout.caretColumn).toBe(COMPOSER_GUTTER_COLUMNS); // "❯ " then the caret
  });

  test('insert appends at the end and flattens newlines to spaces', () => {
    const model = composer();
    model.insert('hello\nworld');
    expect(model.value).toBe('hello world');
  });

  test('long text WRAPS to (width − gutter) and the caret sits on the last row', () => {
    const model = composer();
    model.insert('x'.repeat(10));
    const layout = model.layout(7); // inner width = 7 − 2 = 5
    expect(layout.rows.map((row) => row.text)).toEqual(['xxxxx', 'xxxxx']);
    expect(layout.rowCount).toBe(2);
    expect(layout.caretRow).toBe(1);
    expect(layout.caretColumn).toBe(COMPOSER_GUTTER_COLUMNS + 5);
    expect(layout.rows[0]?.isFirstLine).toBe(true);
    expect(layout.rows[1]?.isFirstLine).toBe(false);
  });

  test('growth is capped at COMPOSER_MAX_ROWS, scrolling to keep the caret (last) row visible', () => {
    const model = composer();
    model.insert('x'.repeat(100));
    const layout = model.layout(4); // inner width 2 → 50 visual lines
    expect(layout.rowCount).toBe(COMPOSER_MAX_ROWS);
    // The window is anchored to the bottom: the last visible row is the final (caret) line.
    expect(layout.rows[layout.rows.length - 1]?.isFirstLine).toBe(false);
    expect(layout.caretRow).toBe(COMPOSER_MAX_ROWS - 1);
  });
});

describe('AgentComposer — editing', () => {
  test('backspace removes the last character', () => {
    const model = composer();
    model.insert('abc');
    model.backspace();
    expect(model.value).toBe('ab');
  });

  test('deletePreviousWord removes the trailing word (shared TextEditing seam)', () => {
    const model = composer();
    model.insert('hello world');
    model.deletePreviousWord();
    expect(model.value).toBe('hello ');
  });

  test('clear empties the buffer', () => {
    const model = composer();
    model.insert('anything');
    model.clear();
    expect(model.value).toBe('');
  });
});

describe('AgentComposer — selection + copy (no phantom newlines across wrap)', () => {
  test('selectedText reconstructs the buffer substring across a wrap boundary', () => {
    const model = composer();
    model.insert('abcdef');
    model.layout(5); // inner width 3 → ['abc','def']
    // Select from line 0 col 1 to line 1 col 2 → buffer offsets 1..5 → "bcde" (NO inserted newline).
    model.beginSelection({ line: 0, column: 1 });
    model.extendSelection({ line: 1, column: 2 });
    expect(model.hasSelection()).toBe(true);
    expect(model.selectedText()).toBe('bcde');
  });

  test('pointAt maps a composer-local cell to (visual line, column) minus the gutter', () => {
    const model = composer();
    model.insert('abcdef');
    model.layout(5); // 2 rows, scrollOffset 0
    const point = model.pointAt(COMPOSER_GUTTER_COLUMNS + 1, 1); // second visible row, one past gutter
    expect(point).toEqual({ line: 1, column: 1 });
  });

  test('copySelection resolves to the selected character count', async () => {
    const model = composer();
    model.insert('abcdef');
    model.layout(10);
    model.beginSelection({ line: 0, column: 1 });
    model.extendSelection({ line: 0, column: 4 });
    expect(await model.copySelection()).toBe(3);
  });
});

describe('AgentComposer — movable cursor + mid-text editing', () => {
  const typed = (text: string) => {
    const model = composer();
    model.insert(text);
    return model;
  };

  test('typing inserts AT the cursor (move into "world", type X → "hello woXrld")', () => {
    const model = typed('hello world');
    expect(model.cursor).toBe(11); // at the end after typing
    for (let index = 0; index < 3; index += 1) model.moveLeft(); // land between "wo" and "rld" (index 8)
    expect(model.cursor).toBe(8);
    model.insert('X');
    expect(model.value).toBe('hello woXrld');
    expect(model.cursor).toBe(9);
  });

  test('the caret RENDERS at the cursor (visual column,row), not pinned to the end', () => {
    const model = typed('hello world');
    for (let index = 0; index < 5; index += 1) model.moveLeft(); // cursor at index 6
    const layout = model.layout(40); // one visual line
    expect(layout.caretRow).toBe(0);
    expect(layout.caretColumn).toBe(COMPOSER_GUTTER_COLUMNS + 6);
  });

  test('Left/Right clamp at the ends', () => {
    const model = typed('ab');
    model.moveRight();
    expect(model.cursor).toBe(2); // clamped at end
    model.moveLeft(); model.moveLeft(); model.moveLeft();
    expect(model.cursor).toBe(0); // clamped at start
  });

  test('word-left / word-right jump by word', () => {
    const model = typed('alpha beta gamma');
    model.moveHome();
    model.moveWordRight();
    expect(model.cursor).toBe(6); // start of "beta" (crossed "alpha" + the space)
    model.moveWordRight();
    expect(model.cursor).toBe(11); // start of "gamma"
    model.moveWordLeft();
    expect(model.cursor).toBe(6); // back to "beta"
  });

  test('Home / End jump to the start / end', () => {
    const model = typed('some text here');
    model.moveHome();
    expect(model.cursor).toBe(0);
    model.moveEnd();
    expect(model.cursor).toBe(14);
  });

  test('Backspace deletes BEFORE the cursor; Delete deletes AT the cursor', () => {
    const model = typed('abcd');
    model.moveLeft(); model.moveLeft(); // cursor between b and c (index 2)
    model.backspace(); // removes "b"
    expect(model.value).toBe('acd');
    expect(model.cursor).toBe(1);
    model.deleteForward(); // removes "c" (at cursor)
    expect(model.value).toBe('ad');
    expect(model.cursor).toBe(1);
  });

  test('Alt+Backspace deletes the WORD BEFORE THE CURSOR (cursor-aware, not the whole value)', () => {
    const model = typed('foo bar baz');
    model.moveWordLeft(); // cursor at start of "baz" (index 8)
    model.deletePreviousWord(); // deletes "bar " before the cursor
    expect(model.value).toBe('foo baz');
    expect(model.cursor).toBe(4); // cursor now before "baz"
  });

  test('Ctrl/Cmd+Backspace clears the whole line', () => {
    const model = typed('clear me entirely');
    model.moveWordLeft(); // cursor mid-text
    model.deleteLine();
    expect(model.value).toBe('');
    expect(model.cursor).toBe(0);
  });

  test('Up/Down move between visual lines; edges report false (fall through to scroll)', () => {
    const model = composer();
    model.insert('x'.repeat(12));
    model.layout(7); // inner width 5 → 3 visual lines: xxxxx / xxxxx / xx
    // cursor at end (index 12) → last visual line
    expect(model.moveDown()).toBe(false); // already on last line
    expect(model.moveUp()).toBe(true); // up to the middle line, same column (clamped)
    model.layout(7);
    expect(model.moveUp()).toBe(true); // up to the first line
    model.layout(7);
    expect(model.moveUp()).toBe(false); // first line → fall through
  });

  test('a just-emptied composer (deleteLine) reports Up/Down as edge → false', () => {
    const model = typed('abc');
    model.deleteLine();
    model.layout(40);
    expect(model.moveUp()).toBe(false);
    expect(model.moveDown()).toBe(false);
  });
});
