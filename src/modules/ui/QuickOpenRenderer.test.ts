import { describe, expect, test } from 'bun:test';
import { QuickOpenRenderer } from './QuickOpenRenderer';

const computeWindow = QuickOpenRenderer.Class.computeWindow;

describe('QuickOpenRenderer.computeWindow (scroll-to-selection math)', () => {
  test('a list that fits the row budget is drawn whole from the top', () => {
    expect(computeWindow(0, 5, 14)).toEqual({ firstVisible: 0, count: 5 });
    expect(computeWindow(4, 5, 14)).toEqual({ firstVisible: 0, count: 5 });
    // Exactly filling the budget still draws from the top (no scroll needed).
    expect(computeWindow(13, 14, 14)).toEqual({ firstVisible: 0, count: 14 });
  });

  test('the selected row is ALWAYS inside the drawn window, for every index of a long list', () => {
    const total = 766; // the demo /tmp case that lost the highlight below the window
    const maxRows = 14;
    for (let selectedIndex = 0; selectedIndex < total; selectedIndex++) {
      const { firstVisible, count } = computeWindow(selectedIndex, total, maxRows);
      expect(count).toBe(maxRows);
      expect(firstVisible).toBeGreaterThanOrEqual(0);
      expect(firstVisible + count).toBeLessThanOrEqual(total);
      // The selection sits within the drawn slice — the whole point of the fix.
      expect(selectedIndex).toBeGreaterThanOrEqual(firstVisible);
      expect(selectedIndex).toBeLessThan(firstVisible + count);
    }
  });

  test('the first page pins to the top and the last page pins to the bottom (no over-scroll)', () => {
    const total = 100;
    const maxRows = 14;
    expect(computeWindow(0, total, maxRows).firstVisible).toBe(0);
    expect(computeWindow(3, total, maxRows).firstVisible).toBe(0);
    // Selecting the last item scrolls exactly to the final page — never past it.
    expect(computeWindow(total - 1, total, maxRows).firstVisible).toBe(total - maxRows);
  });

  test('a mid-list selection is centered within the window', () => {
    const window = computeWindow(50, 100, 14);
    expect(window.firstVisible).toBe(50 - Math.floor((14 - 1) / 2));
    expect(50).toBeGreaterThanOrEqual(window.firstVisible);
    expect(50).toBeLessThan(window.firstVisible + window.count);
  });

  test('a negative selection (no active row) still yields a valid top-anchored window', () => {
    expect(computeWindow(-1, 100, 14)).toEqual({ firstVisible: 0, count: 14 });
  });
});
