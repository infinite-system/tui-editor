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
