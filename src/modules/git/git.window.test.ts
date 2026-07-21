import { test, expect, describe } from 'bun:test';
import { GitWindow } from './git.window';

describe('missingRanges', () => {
  test('all missing → one range covering the window', () => {
    expect(GitWindow.Class.missingRanges(new Set(), 0, 5)).toEqual([{ offset: 0, length: 5 }]);
  });
  test('all loaded → no ranges', () => {
    expect(GitWindow.Class.missingRanges(new Set([0, 1, 2, 3, 4]), 0, 5)).toEqual([]);
  });
  test('a gap in the middle produces one range for the gap only', () => {
    // loaded 0,1,4; window [0,5) → missing 2,3
    expect(GitWindow.Class.missingRanges(new Set([0, 1, 4]), 0, 5)).toEqual([{ offset: 2, length: 2 }]);
  });
  test('two separate gaps → two ranges (batched, not per-row)', () => {
    // loaded 1,4; window [0,6) → missing 0 | 2,3 | 5
    expect(GitWindow.Class.missingRanges(new Set([1, 4]), 0, 6)).toEqual([
      { offset: 0, length: 1 },
      { offset: 2, length: 2 },
      { offset: 5, length: 1 },
    ]);
  });
  test('window offset away from zero', () => {
    // loaded 100,101; window [100,105) → missing 102,103,104
    expect(GitWindow.Class.missingRanges(new Set([100, 101]), 100, 5)).toEqual([{ offset: 102, length: 3 }]);
  });
  test('negative start is clamped to 0', () => {
    expect(GitWindow.Class.missingRanges(new Set(), -3, 4)).toEqual([{ offset: 0, length: 4 }]);
  });
});

describe('evictable', () => {
  test('drops indices outside the keep-window', () => {
    // loaded 0..9; keep [3,7) → evict 0,1,2,7,8,9
    const got = GitWindow.Class.evictable([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3, 4).sort((a, b) => a - b);
    expect(got).toEqual([0, 1, 2, 7, 8, 9]);
  });
  test('keeps everything when all inside the window', () => {
    expect(GitWindow.Class.evictable([3, 4, 5], 3, 4)).toEqual([]);
  });
  test('evicts far-scrolled pages (bounded memory)', () => {
    const loaded = [0, 1, 2, 500, 501, 502];
    // scrolled to ~500; keep [498,506)
    expect(GitWindow.Class.evictable(loaded, 498, 8).sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });
});
