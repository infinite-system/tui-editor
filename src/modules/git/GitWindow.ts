// Pure virtualization helpers for a windowed list (the commit log). Realizes "cost tracks the
// actively observed set": only the visible window (plus a small keep-margin) is ever materialized;
// everything outside is evicted. These are pure and deterministic — unit-testable with no git, no
// tmux — so the load-bearing virtualization logic is proven independently of I/O.

// invariant: Cost tracks the actively observed set (project.invariants.md)

import { Static } from 'ivue/extras';

/** A contiguous run of indices to fetch: commits [offset, offset+length). */
export interface FetchRange {
  offset: number;
  length: number;
}

/**
 * The contiguous runs of indices within `[start, start+count)` that are NOT yet loaded — the
 * minimal set of git-log pages to fetch to fill the window. Merges adjacent gaps into one range so
 * a scroll fetches at most a few pages, never one call per row.
 */
function $missingRanges(loaded: ReadonlySet<number>, start: number, count: number): FetchRange[] {
  const from = Math.max(0, start);
  const to = from + count; // exclusive
  const ranges: FetchRange[] = [];
  let runStart = -1;
  for (let index = from; index < to; index++) {
    const missing = !loaded.has(index);
    if (missing && runStart < 0) runStart = index;
    else if (!missing && runStart >= 0) {
      ranges.push({ offset: runStart, length: index - runStart });
      runStart = -1;
    }
  }
  if (runStart >= 0) ranges.push({ offset: runStart, length: to - runStart });
  return ranges;
}

/**
 * Loaded indices that fall OUTSIDE the keep-window `[keepStart, keepStart+keepCount)` and should be
 * dropped to bound memory. keepCount is typically the viewport height plus a margin above and below.
 */
function $evictable(loaded: Iterable<number>, keepStart: number, keepCount: number): number[] {
  const low = Math.max(0, keepStart);
  const high = keepStart + keepCount; // exclusive
  const evicted: number[] = [];
  for (const index of loaded) if (index < low || index >= high) evicted.push(index);
  return evicted;
}

class $GitWindow {
  static missingRanges = $missingRanges;
  static evictable = $evictable;
}

export namespace GitWindow {
  export const $Class = $GitWindow;
  export const Class = Static($GitWindow);
}
