// Pure parsers for stable Git CLI formats. These produce compact plain records; callers may
// retain or virtualize the arrays without creating a reactive object per status/commit row.

import { Static } from '../system/Static';

export const LOG_FIELD_SEPARATOR = '\x1f';
export const LOG_RECORD_SEPARATOR = '\x1e';
export const LOG_FORMAT = [
  '%H',
  '%h',
  '%an',
  '%ad',
  '%s',
  '%D',
].join('%x1f') + '%x1e';

export interface GitFileRecord {
  path: string;
  xy: string;
  x: string;
  y: string;
  originalPath?: string;
}

export interface GitStatusSnapshot {
  branch: string;
  head: string;
  staged: GitFileRecord[];
  unstaged: GitFileRecord[];
  untracked: GitFileRecord[];
}

export interface CommitRecord {
  sha: string;
  shortSha: string;
  author: string;
  dateIso: string;
  subject: string;
  refs: string[];
}

interface SplitPrefixResult {
  fields: string[];
  rest: string;
}

function splitPrefix(line: string, fieldCount: number): SplitPrefixResult | null {
  const fields: string[] = [];
  let position = 0;

  while (fields.length < fieldCount) {
    const separator = line.indexOf(' ', position);
    if (separator < 0) return null;
    fields.push(line.slice(position, separator));
    position = separator + 1;
  }

  return { fields, rest: line.slice(position) };
}

function decodeGitPath(path: string): string {
  if (path.length < 2 || path[0] !== '"' || path[path.length - 1] !== '"') return path;

  const bytes: number[] = [];
  const encoder = new TextEncoder();
  const escapes: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    '\\': 92,
  };

  let position = 1;
  while (position < path.length - 1) {
    const character = path[position]!;
    if (character !== '\\') {
      const codePoint = path.codePointAt(position)!;
      bytes.push(...encoder.encode(String.fromCodePoint(codePoint)));
      position += codePoint > 0xffff ? 2 : 1;
      continue;
    }

    const escaped = path[position + 1];
    if (escaped === undefined) break;
    if (/[0-7]/.test(escaped)) {
      const octal = path.slice(position + 1, position + 4);
      if (/^[0-7]{3}$/.test(octal)) {
        bytes.push(Number.parseInt(octal, 8));
        position += 4;
        continue;
      }
    }

    bytes.push(escapes[escaped] ?? escaped.charCodeAt(0));
    position += 2;
  }

  return new TextDecoder().decode(Uint8Array.from(bytes));
}

function makeFileRecord(path: string, xy: string, originalPath?: string): GitFileRecord {
  return {
    path: decodeGitPath(path),
    xy,
    x: xy[0] ?? '.',
    y: xy[1] ?? '.',
    ...(originalPath === undefined ? {} : { originalPath: decodeGitPath(originalPath) }),
  };
}

function addTrackedRecord(snapshot: GitStatusSnapshot, record: GitFileRecord): void {
  if (record.x !== '.') snapshot.staged.push(record);
  if (record.y !== '.') snapshot.unstaged.push(record);
}

function parseStatusPorcelainV2Implementation(output: string): GitStatusSnapshot {
  const snapshot: GitStatusSnapshot = {
    branch: '',
    head: '',
    staged: [],
    unstaged: [],
    untracked: [],
  };

  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine) continue;
    if (rawLine.startsWith('# branch.oid ')) {
      const head = rawLine.slice('# branch.oid '.length);
      snapshot.head = head === '(initial)' ? '' : head;
      continue;
    }
    if (rawLine.startsWith('# branch.head ')) {
      snapshot.branch = rawLine.slice('# branch.head '.length);
      continue;
    }
    if (rawLine.startsWith('? ')) {
      snapshot.untracked.push(makeFileRecord(rawLine.slice(2), '??'));
      continue;
    }
    if (rawLine.startsWith('! ')) continue;

    if (rawLine.startsWith('1 ')) {
      const split = splitPrefix(rawLine, 8);
      if (!split) continue;
      addTrackedRecord(snapshot, makeFileRecord(split.rest, split.fields[1] ?? '..'));
      continue;
    }

    if (rawLine.startsWith('2 ')) {
      const split = splitPrefix(rawLine, 9);
      if (!split) continue;
      const tab = split.rest.indexOf('\t');
      const path = tab < 0 ? split.rest : split.rest.slice(0, tab);
      const originalPath = tab < 0 ? undefined : split.rest.slice(tab + 1);
      addTrackedRecord(
        snapshot,
        makeFileRecord(path, split.fields[1] ?? '..', originalPath),
      );
      continue;
    }

    if (rawLine.startsWith('u ')) {
      const split = splitPrefix(rawLine, 10);
      if (!split) continue;
      addTrackedRecord(snapshot, makeFileRecord(split.rest, split.fields[1] ?? 'UU'));
    }
  }

  return snapshot;
}

export interface CommitFileChange {
  /** One status letter: M/A/D/R/C/T/U — a rename/copy similarity score suffix (R100) is dropped. */
  status: string;
  /** The file's path in the commit (for a rename, the NEW path). */
  path: string;
  /** A rename/copy's source path. */
  originalPath?: string;
}

/**
 * Parse `git show --name-status --format=` output: one `<STATUS>\t<path>` line per changed file;
 * renames/copies are `R<score>\t<old>\t<new>` (the new path is the file's identity).
 */
function parseNameStatusImplementation(output: string): CommitFileChange[] {
  const changes: CommitFileChange[] = [];

  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine) continue;
    const fields = rawLine.split('\t');
    const statusField = fields[0];
    const status = statusField?.[0];
    if (!status || !/[A-Z]/.test(status) || fields.length < 2) continue;
    if ((status === 'R' || status === 'C') && fields.length >= 3) {
      changes.push({
        status,
        path: decodeGitPath(fields[2]!),
        originalPath: decodeGitPath(fields[1]!),
      });
    } else {
      changes.push({ status, path: decodeGitPath(fields[1]!) });
    }
  }

  return changes;
}

function parseLogImplementation(output: string): CommitRecord[] {
  const commits: CommitRecord[] = [];

  for (const rawRecord of output.split(LOG_RECORD_SEPARATOR)) {
    const record = rawRecord.replace(/^\r?\n+|\r?\n+$/g, '');
    if (!record) continue;
    const fields = record.split(LOG_FIELD_SEPARATOR);
    if (fields.length < 5) continue;
    const refsField = fields.slice(5).join(LOG_FIELD_SEPARATOR);
    commits.push({
      sha: fields[0] ?? '',
      shortSha: fields[1] ?? '',
      author: fields[2] ?? '',
      dateIso: fields[3] ?? '',
      subject: fields[4] ?? '',
      refs: refsField
        .split(',')
        .map((refName) => refName.trim())
        .filter(Boolean),
    });
  }

  return commits;
}

class $GitParsers {
  static parseStatusPorcelainV2 = parseStatusPorcelainV2Implementation;
  static parseLog = parseLogImplementation;
  static parseNameStatus = parseNameStatusImplementation;
}

export namespace GitParsers {
  export const $Class = $GitParsers;
  export const Class = Static($GitParsers);
}
