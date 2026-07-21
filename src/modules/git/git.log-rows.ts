// The commit-log FLAT ROW MODEL — the virtualized log with inline (VS Code-style) commit
// expansion. An expanded commit contributes its header row plus one row per changed file (or one
// loading placeholder while the lazy fetch is in flight), so the log window scrolls over FLAT rows,
// not commit indices. Pure and shared: the renderer draws exactly this list and the mouse
// hit-tester / keyboard selection index into the SAME flat space, so clicks and Enter always land
// on the row the user sees.
//
// Everything here is O(window + expanded commits): the expanded set is hard-bounded (see
// CommitExpansion), and only the commits inside the visible flat window are consulted.
//
// invariant: Commit expansion is lazy and windowed (src/modules/git/git.invariants.md)
// invariant: Cost tracks the actively observed set (project.invariants.md)
import { Static } from '../system/Static';
import type { CommitFileChange, CommitRecord } from './git.parsers';

/** One expanded commit: its position in the log, its sha, and its changed files (null = loading). */
export interface ExpandedCommit {
  commitIndex: number;
  sha: string;
  files: readonly CommitFileChange[] | null;
}

export interface CommitHeaderRow {
  kind: 'commit';
  commitIndex: number;
  /** undefined = the commit page is not fetched yet (renders the "…" placeholder). */
  record: CommitRecord | undefined;
  expanded: boolean;
}
export interface CommitFileRow {
  kind: 'commitFile';
  commitIndex: number;
  sha: string;
  path: string;
  /** Status letter: M/A/D/R/C/T/U — glyph-colored like the changes list. */
  glyph: string;
  originalPath?: string;
}
export interface CommitLoadingRow {
  kind: 'loading';
  commitIndex: number;
  sha: string;
}
export type CommitLogRow = CommitHeaderRow | CommitFileRow | CommitLoadingRow;

/** Stateless capability: pure flat-row arithmetic + window construction for the commit log. */
class $GitLogRows {
  /** Extra flat rows an expanded commit contributes beyond its header row. */
  static expandedRowCount(entry: ExpandedCommit): number {
    return entry.files === null ? 1 : entry.files.length;
  }

  private static sortedByIndex(expanded: readonly ExpandedCommit[]): ExpandedCommit[] {
    return [...expanded].sort((first, second) => first.commitIndex - second.commitIndex);
  }

  /** Extra (non-header) flat rows contributed by expanded commits BEFORE `commitIndex`. */
  static extraRowsBefore(expanded: readonly ExpandedCommit[], commitIndex: number): number {
    let extra = 0;
    for (const entry of expanded) {
      if (entry.commitIndex < commitIndex) extra += this.expandedRowCount(entry);
    }
    return extra;
  }

  /** Flat index of a commit's header row. */
  static commitFlatIndex(expanded: readonly ExpandedCommit[], commitIndex: number): number {
    return commitIndex + this.extraRowsBefore(expanded, commitIndex);
  }

  /** Total flat rows once the end of history is known; Infinity until (`knownEnd` = commit count). */
  static totalFlatRows(expanded: readonly ExpandedCommit[], knownEnd: number): number {
    if (!Number.isFinite(knownEnd)) return Number.POSITIVE_INFINITY;
    return knownEnd + this.extraRowsBefore(expanded, knownEnd);
  }

  /**
   * The commit whose block (header row + expansion rows) contains flat row `flatIndex` — the
   * piecewise-linear inverse of `commitFlatIndex`. O(|expanded|).
   */
  static commitIndexAtFlatRow(expanded: readonly ExpandedCommit[], flatIndex: number): number {
    let extra = 0;
    for (const entry of this.sortedByIndex(expanded)) {
      const headerFlatIndex = entry.commitIndex + extra;
      if (flatIndex <= headerFlatIndex) return Math.max(0, flatIndex - extra);
      const blockLastFlatIndex = headerFlatIndex + this.expandedRowCount(entry);
      if (flatIndex <= blockLastFlatIndex) return entry.commitIndex;
      extra += this.expandedRowCount(entry);
    }
    return Math.max(0, flatIndex - extra);
  }

  /**
   * Build the visible flat rows `[flatStart, flatStart + rowCount)`. `commitAt` supplies the
   * (sparse) commit records — an unfetched commit renders as a placeholder header, never blocks
   * the window. Only the commits intersecting the window are visited (expansion can only DECREASE
   * how many commits fit), so cost stays O(window + |expanded|).
   */
  static commitLogRows(
    flatStart: number,
    rowCount: number,
    expanded: readonly ExpandedCommit[],
    commitAt: (commitIndex: number) => CommitRecord | undefined,
    knownEnd: number,
  ): CommitLogRow[] {
    const sorted = this.sortedByIndex(expanded);
    const entriesByIndex = new Map(sorted.map((entry) => [entry.commitIndex, entry]));
    const rows: CommitLogRow[] = [];
    const start = Math.max(0, flatStart);
    let commitIndex = this.commitIndexAtFlatRow(sorted, start);
    let flatIndex = this.commitFlatIndex(sorted, commitIndex);

    while (rows.length < rowCount && commitIndex < knownEnd) {
      const entry = entriesByIndex.get(commitIndex);
      if (flatIndex >= start) {
        rows.push({
          kind: 'commit',
          commitIndex,
          record: commitAt(commitIndex),
          expanded: entry !== undefined,
        });
      }
      flatIndex += 1;
      if (entry) {
        if (entry.files === null) {
          if (rows.length < rowCount && flatIndex >= start) {
            rows.push({ kind: 'loading', commitIndex, sha: entry.sha });
          }
          flatIndex += 1;
        } else {
          for (const change of entry.files) {
            if (rows.length >= rowCount) break;
            if (flatIndex >= start) {
              rows.push({
                kind: 'commitFile',
                commitIndex,
                sha: entry.sha,
                path: change.path,
                glyph: change.status,
                ...(change.originalPath === undefined ? {} : { originalPath: change.originalPath }),
              });
            }
            flatIndex += 1;
          }
        }
      }
      commitIndex += 1;
    }

    return rows;
  }
}

export namespace GitLogRows {
  export const $Class = $GitLogRows;
  export const Class = Static($GitLogRows);
}
