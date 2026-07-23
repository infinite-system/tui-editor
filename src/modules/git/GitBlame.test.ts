// The porcelain blame parser in isolation: a 1-based line → BlameLine map, with a commit's metadata
// emitted once and reused across its later hunks, and the all-zero sha mapped to a friendly uncommitted
// label. Scripted porcelain in, asserted map out — no git spawn.
import { test, expect } from 'bun:test';
import { GitBlame } from './GitBlame';

// Two commits + one uncommitted line. Line 2 repeats Alice's sha WITHOUT re-sending her metadata —
// exactly what `git blame --porcelain` does — so the parser must reuse the remembered metadata.
const PORCELAIN = [
  '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b 1 1 2',
  'author Alice',
  'author-mail <alice@example.com>',
  'author-time 1700000000',
  'author-tz +0000',
  'committer Alice',
  'committer-time 1700000000',
  'summary Initial commit',
  'filename foo.ts',
  '\tconst x = 1',
  '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b 2 2',
  '\tconst y = 2',
  '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c 3 3 1',
  'author Bob',
  'author-mail <bob@example.com>',
  'author-time 1700086400',
  'author-tz +0000',
  'committer Bob',
  'summary Add y logic',
  'filename foo.ts',
  '\tconst z = 3',
  '0000000000000000000000000000000000000000 4 4 1',
  'author Not Committed Yet',
  'author-mail <not.committed.yet>',
  'author-time 1700100000',
  'author-tz +0000',
  'committer Not Committed Yet',
  'summary Version of foo.ts from working tree',
  'filename foo.ts',
  '\tconst w = 4',
  '',
].join('\n');

test('parses each line to its author, time (ms), and summary', () => {
  const map = GitBlame.Class.parsePorcelain(PORCELAIN);
  expect(map.get(1)).toMatchObject({ author: 'Alice', summary: 'Initial commit', authorTimeMs: 1700000000000, uncommitted: false });
  expect(map.get(3)).toMatchObject({ author: 'Bob', summary: 'Add y logic', uncommitted: false });
});

test('a repeated sha reuses the commit metadata sent on its first hunk', () => {
  const map = GitBlame.Class.parsePorcelain(PORCELAIN);
  // Line 2 shares Alice's sha and carried NO metadata of its own — must inherit Alice/Initial commit.
  expect(map.get(2)?.author).toBe('Alice');
  expect(map.get(2)?.summary).toBe('Initial commit');
  expect(map.get(2)?.sha).toBe(map.get(1)?.sha);
});

test('the all-zero sha is a friendly uncommitted line', () => {
  const map = GitBlame.Class.parsePorcelain(PORCELAIN);
  const line = map.get(4);
  expect(line?.uncommitted).toBe(true);
  expect(line?.author).toBe('You (uncommitted)');
  expect(line?.summary).toBe('Uncommitted changes');
});

test('empty / non-blame output yields an empty map (no throw)', () => {
  expect(GitBlame.Class.parsePorcelain('').size).toBe(0);
  expect(GitBlame.Class.parsePorcelain('fatal: no such path\n').size).toBe(0);
});
