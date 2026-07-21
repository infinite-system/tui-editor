// Pure virtualization helpers for a windowed list (the commit log). Realizes "cost tracks the
// actively observed set": only the visible window (plus a small keep-margin) is ever materialized;
// everything outside is evicted. These are pure and deterministic — unit-testable with no git, no
// tmux — so the load-bearing virtualization logic is proven independently of I/O.

// invariant: Cost tracks the actively observed set (project.invariants.md)

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
export function missingRanges(loaded: ReadonlySet<number>, start: number, count: number): FetchRange[] {
  const from = Math.max(0, start);
  const to = from + count; // exclusive
  const ranges: FetchRange[] = [];
  let runStart = -1;
  for (let i = from; i < to; i++) {
    const missing = !loaded.has(i);
    if (missing && runStart < 0) runStart = i;
    else if (!missing && runStart >= 0) {
      ranges.push({ offset: runStart, length: i - runStart });
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
export function evictable(loaded: Iterable<number>, keepStart: number, keepCount: number): number[] {
  const lo = Math.max(0, keepStart);
  const hi = keepStart + keepCount; // exclusive
  const out: number[] = [];
  for (const i of loaded) if (i < lo || i >= hi) out.push(i);
  return out;
}
