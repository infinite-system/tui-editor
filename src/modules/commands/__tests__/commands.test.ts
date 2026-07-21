import { test, expect } from 'bun:test';
import { CommandRegistry, fuzzyScore } from '../CommandRegistry';

test('fuzzyScore matches subsequences and rejects non-matches', () => {
  expect(fuzzyScore('sv', 'File: Save')).toBeGreaterThanOrEqual(0);
  expect(fuzzyScore('save', 'File: Save')).toBeGreaterThanOrEqual(0);
  expect(fuzzyScore('xyz', 'File: Save')).toBe(-1);
  expect(fuzzyScore('', 'anything')).toBe(0);
});

test('tighter (adjacent) matches score lower than spread-out ones', () => {
  const adjacent = fuzzyScore('save', 'Save');
  const spread = fuzzyScore('save', 'Show a value everywhere');
  expect(adjacent).toBeLessThan(spread);
});

test('registry filters by query and runs the selected command', () => {
  const r = new CommandRegistry.Class();
  let ran = '';
  r.registerAll([
    { id: 'a', title: 'File: Save', run: () => (ran = 'save') },
    { id: 'b', title: 'Edit: Undo', run: () => (ran = 'undo') },
    { id: 'c', title: 'View: Toggle Theme', run: () => (ran = 'theme') },
  ]);
  r.openPalette();
  expect(r.filtered.length).toBe(3);
  r.setQuery('undo');
  expect(r.filtered.map((c) => c.id)).toEqual(['b']);
  r.runSelected();
  expect(ran).toBe('undo');
  expect(r.open.value).toBe(false);
});

test('when() gates command availability', () => {
  const r = new CommandRegistry.Class();
  let enabled = false;
  r.register({ id: 'x', title: 'Gated', when: () => enabled, run: () => {} });
  r.openPalette();
  expect(r.filtered.length).toBe(0);
  enabled = true;
  r.setQuery('');
  expect(r.filtered.length).toBe(1);
});

test('selection wraps around the filtered list', () => {
  const r = new CommandRegistry.Class();
  r.registerAll([
    { id: 'a', title: 'Aaa', run: () => {} },
    { id: 'b', title: 'Bbb', run: () => {} },
  ]);
  r.openPalette();
  expect(r.selectedIndex.value).toBe(0);
  r.moveSelection(-1);
  expect(r.selectedIndex.value).toBe(1); // wrapped
  r.moveSelection(1);
  expect(r.selectedIndex.value).toBe(0);
});
