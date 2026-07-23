// Unit contract for the pure navigation-history model: record / back / forward, forward-truncation
// on a new navigation after going back, same-line duplicate collapse, the cap dropping oldest, and
// the empty / at-end no-ops. Plain values only — no editor, no LSP.
import { test, expect, describe } from 'bun:test';
import { NavigationHistory, type Location } from '../NavigationHistory';

const at = (documentPath: string, line: number, column = 0): Location => ({
  documentPath,
  line,
  column,
});

describe('NavigationHistory', () => {
  test('starts empty: no current entry, no back/forward', () => {
    const history = new NavigationHistory.Class();
    expect(history.size).toBe(0);
    expect(history.currentEntry).toBeNull();
    expect(history.canGoBack).toBe(false);
    expect(history.canGoForward).toBe(false);
    expect(history.back()).toBeNull();
    expect(history.forward()).toBeNull();
  });

  test('record appends and makes the newest current', () => {
    const history = new NavigationHistory.Class();
    history.record(at('a.ts', 0));
    history.record(at('b.ts', 5));
    expect(history.size).toBe(2);
    expect(history.currentEntry).toEqual(at('b.ts', 5));
    expect(history.canGoBack).toBe(true);
    expect(history.canGoForward).toBe(false);
  });

  test('back then forward walk between recorded locations', () => {
    const history = new NavigationHistory.Class();
    history.record(at('a.ts', 1));
    history.record(at('b.ts', 2));
    history.record(at('c.ts', 3));
    expect(history.back()).toEqual(at('b.ts', 2));
    expect(history.back()).toEqual(at('a.ts', 1));
    expect(history.back()).toBeNull(); // at the oldest — no move
    expect(history.currentEntry).toEqual(at('a.ts', 1));
    expect(history.forward()).toEqual(at('b.ts', 2));
    expect(history.forward()).toEqual(at('c.ts', 3));
    expect(history.forward()).toBeNull(); // at the newest — no move
  });

  test('a new navigation after going back TRUNCATES the forward history', () => {
    const history = new NavigationHistory.Class();
    history.record(at('a.ts', 1));
    history.record(at('b.ts', 2));
    history.record(at('c.ts', 3));
    expect(history.back()).toEqual(at('b.ts', 2)); // now at index 1, [c] is ahead
    history.record(at('d.ts', 4)); // new branch — [c] must be discarded
    expect(history.size).toBe(3);
    expect(history.canGoForward).toBe(false);
    expect(history.currentEntry).toEqual(at('d.ts', 4));
    expect(history.back()).toEqual(at('b.ts', 2));
    expect(history.forward()).toEqual(at('d.ts', 4));
  });

  test('same document + same line collapses (drift never spams the stack)', () => {
    const history = new NavigationHistory.Class();
    history.record(at('a.ts', 10, 0));
    history.record(at('a.ts', 10, 4)); // same line, drift right — updates column in place
    history.record(at('a.ts', 10, 4)); // exact duplicate — nothing changes
    expect(history.size).toBe(1);
    expect(history.currentEntry).toEqual(at('a.ts', 10, 4));
  });

  test('a DIFFERENT line in the same document is a real entry (intra-file navigation)', () => {
    const history = new NavigationHistory.Class();
    history.record(at('a.ts', 10));
    history.record(at('a.ts', 500)); // jump to another symbol in the same file
    expect(history.size).toBe(2);
    expect(history.back()).toEqual(at('a.ts', 10));
  });

  test('the list caps at 100, dropping the oldest', () => {
    const history = new NavigationHistory.Class();
    for (let index = 0; index < 150; index += 1) history.record(at(`file${index}.ts`, index));
    expect(history.size).toBe(100);
    expect(history.currentEntry).toEqual(at('file149.ts', 149));
    // Walk all the way back: the oldest surviving entry is file50 (the first 50 were dropped).
    let steps = 0;
    while (history.back() !== null) steps += 1;
    expect(steps).toBe(99);
    expect(history.currentEntry).toEqual(at('file50.ts', 50));
  });

  test('clear resets to empty', () => {
    const history = new NavigationHistory.Class();
    history.record(at('a.ts', 1));
    history.record(at('b.ts', 2));
    history.clear();
    expect(history.size).toBe(0);
    expect(history.currentEntry).toBeNull();
    expect(history.canGoBack).toBe(false);
  });
});
