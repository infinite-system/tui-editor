import { expect, test } from 'bun:test';
import {
  LOG_FIELD_SEPARATOR,
  LOG_RECORD_SEPARATOR,
  GitParsers,
} from '../git.parsers';

test('porcelain v2 parser separates staged unstaged and untracked XY records', () => {
  const output = [
    '# branch.oid 0123456789abcdef0123456789abcdef01234567',
    '# branch.head feature/parser',
    '1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb staged.ts',
    '1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb unstaged.ts',
    '1 AM N... 100644 100644 100644 aaaaaaa bbbbbbb both.ts',
    '? untracked.md',
    '',
  ].join('\n');

  const status = GitParsers.Class.parseStatusPorcelainV2(output);

  expect(status.branch).toBe('feature/parser');
  expect(status.head).toBe('0123456789abcdef0123456789abcdef01234567');
  expect(status.staged.map((record) => [record.path, record.xy])).toEqual([
    ['staged.ts', 'M.'],
    ['both.ts', 'AM'],
  ]);
  expect(status.unstaged.map((record) => [record.path, record.xy])).toEqual([
    ['unstaged.ts', '.M'],
    ['both.ts', 'AM'],
  ]);
  expect(status.untracked).toEqual([
    { path: 'untracked.md', xy: '??', x: '?', y: '?' },
  ]);
});

test('porcelain v2 parser decodes rename paths and quoted UTF-8 bytes', () => {
  const output = [
    '# branch.oid (initial)',
    '# branch.head main',
    '2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 "new name.ts"\t"old name.ts"',
    '? "caf\\303\\251.ts"',
  ].join('\n');

  const status = GitParsers.Class.parseStatusPorcelainV2(output);

  expect(status.head).toBe('');
  expect(status.staged[0]).toEqual({
    path: 'new name.ts',
    originalPath: 'old name.ts',
    xy: 'R.',
    x: 'R',
    y: '.',
  });
  expect(status.untracked[0]?.path).toBe('café.ts');
});

test('log parser returns compact commit records', () => {
  const first = [
    '0123456789abcdef0123456789abcdef01234567',
    '0123456',
    'Ada Lovelace',
    '2026-07-21T10:30:00-04:00',
    'Add parser',
    'HEAD -> main, tag: v1.0',
  ].join(LOG_FIELD_SEPARATOR);
  const second = [
    '89abcdef0123456789abcdef0123456789abcdef',
    '89abcde',
    'Grace Hopper',
    '2026-07-20T08:00:00-04:00',
    'Initial commit',
    '',
  ].join(LOG_FIELD_SEPARATOR);

  const commits = GitParsers.Class.parseLog(
    `${first}${LOG_RECORD_SEPARATOR}\n${second}${LOG_RECORD_SEPARATOR}\n`,
  );

  expect(commits).toEqual([
    {
      sha: '0123456789abcdef0123456789abcdef01234567',
      shortSha: '0123456',
      author: 'Ada Lovelace',
      dateIso: '2026-07-21T10:30:00-04:00',
      subject: 'Add parser',
      refs: ['HEAD -> main', 'tag: v1.0'],
    },
    {
      sha: '89abcdef0123456789abcdef0123456789abcdef',
      shortSha: '89abcde',
      author: 'Grace Hopper',
      dateIso: '2026-07-20T08:00:00-04:00',
      subject: 'Initial commit',
      refs: [],
    },
  ]);
});
