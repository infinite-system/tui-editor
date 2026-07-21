// The git changes-list ROW MODEL — one flat list of typed rows (section headers + file rows +
// placeholder) built from the repository's status buckets. Pure and shared: the renderer draws
// exactly this list and the mouse hit-tester indexes into the SAME list, so clicks always land on
// the row the user sees (the lesson from the tree: renderer and hit-test must share layout math).
import { Static } from '../system/Static';
import type { GitFileRecord } from './GitParsers';

export type ChangeBucket = 'staged' | 'unstaged' | 'untracked';

export interface HeaderRow {
  kind: 'header';
  label: string;
  count: number;
}
export interface FileRow {
  kind: 'file';
  bucket: ChangeBucket;
  path: string;
  /** Human status letter: M/A/D/R/C/U/? — never a raw porcelain xy pair. */
  glyph: string;
}
export interface PlaceholderRow {
  kind: 'placeholder';
  label: string;
}
export type ChangeRow = HeaderRow | FileRow | PlaceholderRow;

/** Porcelain xy → one human letter for the bucket's relevant side. */
function statusGlyphImplementation(xy: string, bucket: ChangeBucket): string {
  if (bucket === 'untracked') return '?';
  const staged = xy.charAt(0);
  const worktree = xy.charAt(1);
  const relevant = bucket === 'staged' ? staged : worktree;
  const known = ['M', 'A', 'D', 'R', 'C', 'U', 'T'];
  if (known.includes(relevant)) return relevant;
  return 'M';
}

/** Build the flat row list: headers with counts, glyphed file rows, or a single placeholder. */
function buildChangeRowsImplementation(
  staged: readonly GitFileRecord[],
  unstaged: readonly GitFileRecord[],
  untracked: readonly GitFileRecord[],
): ChangeRow[] {
  const rows: ChangeRow[] = [];
  const sections: Array<{ label: string; bucket: ChangeBucket; files: readonly GitFileRecord[] }> = [
    { label: 'Staged Changes', bucket: 'staged', files: staged },
    { label: 'Changes', bucket: 'unstaged', files: unstaged },
    { label: 'Untracked', bucket: 'untracked', files: untracked },
  ];
  for (const section of sections) {
    if (section.files.length === 0) continue;
    rows.push({ kind: 'header', label: section.label, count: section.files.length });
    for (const file of section.files) {
      rows.push({
        kind: 'file',
        bucket: section.bucket,
        path: file.path,
        glyph: statusGlyphImplementation(file.xy, section.bucket),
      });
    }
  }
  if (rows.length === 0) rows.push({ kind: 'placeholder', label: '(no changes)' });
  return rows;
}

/** Index of the next/previous FILE row from `fromIndex` (headers are skipped); -1 if none. */
function nextFileRowImplementation(rows: readonly ChangeRow[], fromIndex: number, direction: 1 | -1): number {
  for (let index = fromIndex + direction; index >= 0 && index < rows.length; index += direction) {
    if (rows[index]?.kind === 'file') return index;
  }
  return -1;
}

class $GitRows {
  /** Porcelain xy → one human letter for the bucket's relevant side. */
  static statusGlyph = statusGlyphImplementation;
  /** Build the flat row list: headers with counts, glyphed file rows, or a single placeholder. */
  static buildChangeRows = buildChangeRowsImplementation;
  /** Index of the next/previous FILE row (headers skipped); -1 if none. */
  static nextFileRow = nextFileRowImplementation;
}

export namespace GitRows {
  export const $Class = $GitRows;
  export const Class = Static($GitRows);
}
