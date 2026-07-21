import { test, expect } from 'bun:test';
import { GitRows } from './git.rows';
import type { GitFileRecord } from './git.parsers';

function file(path: string, xy: string): GitFileRecord {
  return { path, xy } as GitFileRecord;
}

test('sections appear only when non-empty, with counts and glyphed files', () => {
  const rows = GitRows.Class.buildChangeRows(
    [file('a.ts', 'M.')],
    [file('b.ts', '.M'), file('c.ts', '.D')],
    [file('new.txt', '??')],
  );
  expect(rows).toEqual([
    { kind: 'header', label: 'Staged Changes', count: 1 },
    { kind: 'file', bucket: 'staged', path: 'a.ts', glyph: 'M' },
    { kind: 'header', label: 'Changes', count: 2 },
    { kind: 'file', bucket: 'unstaged', path: 'b.ts', glyph: 'M' },
    { kind: 'file', bucket: 'unstaged', path: 'c.ts', glyph: 'D' },
    { kind: 'header', label: 'Untracked', count: 1 },
    { kind: 'file', bucket: 'untracked', path: 'new.txt', glyph: '?' },
  ]);
});

test('clean tree yields the placeholder row', () => {
  expect(GitRows.Class.buildChangeRows([], [], [])).toEqual([{ kind: 'placeholder', label: '(no changes)' }]);
});

test('statusGlyph picks the bucket-relevant porcelain side', () => {
  expect(GitRows.Class.statusGlyph('A.', 'staged')).toBe('A'); // staged side
  expect(GitRows.Class.statusGlyph('.D', 'unstaged')).toBe('D'); // worktree side
  expect(GitRows.Class.statusGlyph('R.', 'staged')).toBe('R');
  expect(GitRows.Class.statusGlyph('??', 'untracked')).toBe('?');
  expect(GitRows.Class.statusGlyph('..', 'unstaged')).toBe('M'); // unknown -> M, never a raw code
});

test('nextFileRow skips headers both directions and returns -1 at the ends', () => {
  const rows = GitRows.Class.buildChangeRows([file('a.ts', 'M.')], [file('b.ts', '.M')], []);
  // rows: 0 header, 1 file a, 2 header, 3 file b
  expect(GitRows.Class.nextFileRow(rows, -1, 1)).toBe(1); // first file from the top
  expect(GitRows.Class.nextFileRow(rows, 1, 1)).toBe(3); // skips the Changes header
  expect(GitRows.Class.nextFileRow(rows, 3, -1)).toBe(1); // back up, skips the header
  expect(GitRows.Class.nextFileRow(rows, 3, 1)).toBe(-1); // no file past the last
});
