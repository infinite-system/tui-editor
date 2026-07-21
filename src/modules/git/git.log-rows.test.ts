import { expect, test } from 'bun:test';
import { GitLogRows, type ExpandedCommit } from './git.log-rows';
import type { CommitRecord } from './git.parsers';

const {
  commitFlatIndex,
  commitIndexAtFlatRow,
  commitLogRows,
  expandedRowCount,
  extraRowsBefore,
  totalFlatRows,
} = GitLogRows.Class;

function record(index: number): CommitRecord {
  return {
    sha: `sha-${index}`,
    shortSha: `s${index}`,
    author: 'a',
    dateIso: '2026-07-21T00:00:00+00:00',
    subject: `commit ${index}`,
    refs: [],
  };
}

function expandedWithFiles(commitIndex: number, fileCount: number): ExpandedCommit {
  return {
    commitIndex,
    sha: `sha-${commitIndex}`,
    files: Array.from({ length: fileCount }, (unused, fileIndex) => ({
      status: 'M',
      path: `file-${commitIndex}-${fileIndex}.ts`,
    })),
  };
}

const loadingAt = (commitIndex: number): ExpandedCommit => ({
  commitIndex,
  sha: `sha-${commitIndex}`,
  files: null,
});

// --- expansion arithmetic --------------------------------------------------------------------

test('expansion arithmetic: sizes, offsets, and totals', () => {
  const expanded = [expandedWithFiles(2, 3), loadingAt(5)];
  expect(expandedRowCount(expanded[0]!)).toBe(3);
  expect(expandedRowCount(expanded[1]!)).toBe(1); // loading counts as one placeholder row
  expect(extraRowsBefore(expanded, 0)).toBe(0);
  expect(extraRowsBefore(expanded, 3)).toBe(3); // only commit 2's files
  expect(extraRowsBefore(expanded, 6)).toBe(4); // commit 2's files + commit 5's loading row
  expect(commitFlatIndex(expanded, 2)).toBe(2); // expansion inserts AFTER the header
  expect(commitFlatIndex(expanded, 3)).toBe(6); // shifted past 3 file rows
  expect(totalFlatRows(expanded, 10)).toBe(14);
  expect(totalFlatRows(expanded, Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
});

test('commitIndexAtFlatRow inverts commitFlatIndex and maps file rows to their commit', () => {
  const expanded = [expandedWithFiles(2, 3), loadingAt(5)];
  // Flat layout: 0,1 commits; 2 header; 3,4,5 files of 2; 6 commit 3; 7 commit 4; 8 header 5;
  // 9 loading of 5; 10 commit 6 …
  expect(commitIndexAtFlatRow(expanded, 0)).toBe(0);
  expect(commitIndexAtFlatRow(expanded, 2)).toBe(2);
  expect(commitIndexAtFlatRow(expanded, 3)).toBe(2); // a file row belongs to its commit's block
  expect(commitIndexAtFlatRow(expanded, 5)).toBe(2);
  expect(commitIndexAtFlatRow(expanded, 6)).toBe(3);
  expect(commitIndexAtFlatRow(expanded, 9)).toBe(5); // the loading row
  expect(commitIndexAtFlatRow(expanded, 10)).toBe(6);
  for (let flatIndex = 0; flatIndex < 12; flatIndex++) {
    const commitIndex = commitIndexAtFlatRow(expanded, flatIndex);
    expect(commitFlatIndex(expanded, commitIndex)).toBeLessThanOrEqual(flatIndex);
  }
});

// --- windowing -------------------------------------------------------------------------------

test('a window with no expansion is one commit row per flat row', () => {
  const rows = commitLogRows(3, 4, [], record, Number.POSITIVE_INFINITY);
  expect(rows.map((row) => row.kind)).toEqual(['commit', 'commit', 'commit', 'commit']);
  expect(rows.map((row) => (row.kind === 'commit' ? row.commitIndex : -1))).toEqual([3, 4, 5, 6]);
});

test('an expanded commit contributes its header plus indented file rows inside the window', () => {
  const expanded = [expandedWithFiles(1, 2)];
  const rows = commitLogRows(0, 6, expanded, record, Number.POSITIVE_INFINITY);
  expect(rows).toMatchObject([
    { kind: 'commit', commitIndex: 0, expanded: false },
    { kind: 'commit', commitIndex: 1, expanded: true },
    { kind: 'commitFile', commitIndex: 1, sha: 'sha-1', path: 'file-1-0.ts', glyph: 'M' },
    { kind: 'commitFile', commitIndex: 1, sha: 'sha-1', path: 'file-1-1.ts', glyph: 'M' },
    { kind: 'commit', commitIndex: 2, expanded: false },
    { kind: 'commit', commitIndex: 3, expanded: false },
  ]);
});

test('windowing STARTS mid-expansion: scrolling into an expanded block shows its remaining file rows', () => {
  const expanded = [expandedWithFiles(1, 3)];
  // Flat: 0 commit0, 1 header1, 2..4 files, 5 commit2. Window [3, 3):
  const rows = commitLogRows(3, 3, expanded, record, Number.POSITIVE_INFINITY);
  expect(rows).toMatchObject([
    { kind: 'commitFile', commitIndex: 1, path: 'file-1-1.ts' },
    { kind: 'commitFile', commitIndex: 1, path: 'file-1-2.ts' },
    { kind: 'commit', commitIndex: 2 },
  ]);
});

test('windowing ENDS mid-expansion: the window truncates the file rows, never overflows', () => {
  const expanded = [expandedWithFiles(1, 5)];
  const rows = commitLogRows(0, 4, expanded, record, Number.POSITIVE_INFINITY);
  expect(rows).toHaveLength(4);
  expect(rows.map((row) => row.kind)).toEqual(['commit', 'commit', 'commitFile', 'commitFile']);
});

test('a loading expansion renders exactly one placeholder row until the fetch lands', () => {
  const rows = commitLogRows(0, 4, [loadingAt(1)], record, Number.POSITIVE_INFINITY);
  expect(rows).toMatchObject([
    { kind: 'commit', commitIndex: 0 },
    { kind: 'commit', commitIndex: 1, expanded: true },
    { kind: 'loading', commitIndex: 1, sha: 'sha-1' },
    { kind: 'commit', commitIndex: 2 },
  ]);
});

test('an expanded EMPTY commit keeps its header and adds no rows', () => {
  const rows = commitLogRows(0, 3, [expandedWithFiles(1, 0)], record, Number.POSITIVE_INFINITY);
  expect(rows).toMatchObject([
    { kind: 'commit', commitIndex: 0 },
    { kind: 'commit', commitIndex: 1, expanded: true },
    { kind: 'commit', commitIndex: 2 },
  ]);
});

test('rows stop at knownEnd and unfetched records surface as undefined (placeholder headers)', () => {
  const sparse = (commitIndex: number) => (commitIndex === 1 ? undefined : record(commitIndex));
  const rows = commitLogRows(0, 10, [], sparse, 3);
  expect(rows).toHaveLength(3);
  expect(rows.map((row) => (row.kind === 'commit' ? row.record?.shortSha : ''))).toEqual([
    's0',
    undefined,
    's2',
  ]);
});

test('a rename file row carries the new path plus its originalPath', () => {
  const expanded: ExpandedCommit[] = [
    {
      commitIndex: 0,
      sha: 'sha-0',
      files: [{ status: 'R', path: 'renamed.ts', originalPath: 'original.ts' }],
    },
  ];
  const rows = commitLogRows(0, 2, expanded, record, Number.POSITIVE_INFINITY);
  expect(rows[1]).toMatchObject({
    kind: 'commitFile',
    glyph: 'R',
    path: 'renamed.ts',
    originalPath: 'original.ts',
  });
});
