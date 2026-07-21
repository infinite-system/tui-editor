// Word-wrap mapping layer — a PURE logical↔visual projection over the coordinate model.
// When word wrap is ON, one logical line renders as one or more VISUAL rows; this module is the
// single source of that mapping. It never touches the document: segments are descriptors over the
// line's grapheme axis, computed on demand and memoized by content (revision-proof — an edited
// line is a new string).
//
// Coordinate convention: `startDisplayColumn` is the segment's first display column on the
// LOGICAL line's continuous column axis (tabs expand against that axis, so a tab's width never
// depends on which visual row it landed on). A visual column within a row is
// `displayColumn(line, col) - segment.startDisplayColumn`.
//
// Cursor convention (no affinity bit): a cursor column that equals a wrap boundary belongs to the
// NEXT segment — it renders at visual column 0 of the following row. End-of-line belongs to the
// last segment.
//
// invariant: Word wrap is a pure view mapping (editor.invariants.md)
// invariant: Cost tracks the actively observed set (project.invariants.md)
import { Static } from 'ivue/extras';
import {
  graphemes,
  graphemeWidth,
  displayColumn,
  graphemeAtDisplayColumn,
} from './editor.coordinates';

export interface WrapSegment {
  /** First grapheme of the segment (inclusive). */
  startGrapheme: number;
  /** End grapheme of the segment (exclusive). */
  endGrapheme: number;
  /** Display column of the segment start on the LOGICAL line's column axis. */
  startDisplayColumn: number;
}

/** The minimal document surface the window walk needs (TextDocument satisfies it). */
export interface WrappableDocument {
  lineCount: number;
  line(index: number): string;
}

export interface VisualRow {
  lineIndex: number;
  segmentIndex: number;
  segment: WrapSegment;
  /** True on a logical line's FIRST visual row (the only row that shows the line number). */
  firstOfLine: boolean;
}

const TAB_WIDTH = 4;

// Memoized wrapping, keyed by width + line content (content-keyed = revision-proof). Bounded the
// same way the coordinate memos are: on overflow the oldest half drops (insertion order).
const WRAP_MEMO_CAP = 512;
const wrapMemo = new Map<string, WrapSegment[]>();

function isBreakableAfter(cluster: string): boolean {
  return cluster === ' ' || cluster === '\t';
}

/**
 * Wrap one logical line at `wrapWidth` display columns into segment descriptors. Breaks prefer
 * word boundaries (AFTER a whitespace run, so trailing spaces stay on the earlier row); an
 * unbroken run longer than the width hard-breaks mid-word. Grapheme-safe by construction — the
 * walk is over grapheme clusters, so a cluster (emoji, CJK, base+combining) is never split. A
 * single cluster wider than the width still gets a row of its own (it overflows; it cannot split).
 * An empty line yields one empty segment.
 */
function $wrapLine(lineText: string, wrapWidth: number): WrapSegment[] {
  const width = Math.max(1, Math.floor(wrapWidth));
  const memoKey = `${width}:${lineText}`;
  const cached = wrapMemo.get(memoKey);
  if (cached !== undefined) return cached;

  const clusters = graphemes(lineText);
  const segments: WrapSegment[] = [];
  if (clusters.length === 0) {
    segments.push({ startGrapheme: 0, endGrapheme: 0, startDisplayColumn: 0 });
  } else {
    // Per-cluster start columns on the logical line's continuous axis (tab-expanded, wide-aware).
    const columns: number[] = new Array(clusters.length + 1);
    columns[0] = 0;
    for (let index = 0; index < clusters.length; index++) {
      const cluster = clusters[index] ?? '';
      const previousColumn = columns[index] ?? 0;
      const clusterWidth =
        cluster === '\t' ? TAB_WIDTH - (previousColumn % TAB_WIDTH) : graphemeWidth(cluster);
      columns[index + 1] = previousColumn + clusterWidth;
    }

    let segmentStart = 0;
    while (segmentStart < clusters.length) {
      const segmentStartColumn = columns[segmentStart] ?? 0;
      // Furthest end that still fits the width — at least one cluster (an oversized cluster
      // occupies its own overflowing row rather than splitting).
      let fitEnd = segmentStart + 1;
      while (
        fitEnd < clusters.length &&
        (columns[fitEnd + 1] ?? 0) - segmentStartColumn <= width
      ) {
        fitEnd += 1;
      }
      if (fitEnd >= clusters.length) {
        segments.push({
          startGrapheme: segmentStart,
          endGrapheme: clusters.length,
          startDisplayColumn: segmentStartColumn,
        });
        break;
      }
      // Prefer a word break: the LAST position in (segmentStart, fitEnd] right after whitespace.
      let breakAt = fitEnd;
      for (let candidate = fitEnd; candidate > segmentStart; candidate--) {
        if (isBreakableAfter(clusters[candidate - 1] ?? '')) {
          breakAt = candidate;
          break;
        }
      }
      segments.push({
        startGrapheme: segmentStart,
        endGrapheme: breakAt,
        startDisplayColumn: segmentStartColumn,
      });
      segmentStart = breakAt;
    }
  }

  if (wrapMemo.size >= WRAP_MEMO_CAP) {
    let dropped = 0;
    for (const key of wrapMemo.keys()) {
      wrapMemo.delete(key);
      if (++dropped >= WRAP_MEMO_CAP / 2) break;
    }
  }
  wrapMemo.set(memoKey, segments);
  return segments;
}

/** Number of visual rows a logical line occupies at `wrapWidth`. */
function $visualRowCount(lineText: string, wrapWidth: number): number {
  return $wrapLine(lineText, wrapWidth).length;
}

/**
 * The segment a cursor grapheme column belongs to. A column equal to a wrap boundary belongs to
 * the NEXT segment (renders at visual column 0 of the following row); end-of-line belongs to the
 * last segment. Columns outside [0, lineLength] clamp.
 */
function $segmentIndexForCursor(segments: WrapSegment[], graphemeColumn: number): number {
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (!segment) break;
    if (graphemeColumn < segment.endGrapheme) return index;
  }
  return segments.length - 1;
}

/**
 * The flyweight window walk: the visual rows visible from `scrollTop` (a LOGICAL line index — the
 * window always starts at a logical line's FIRST visual row) for a viewport `height` rows tall.
 * Cost is O(window): only lines that contribute rows to the window are wrapped; a long line
 * contributes multiple rows and fills the window faster.
 */
function $visualRowsForWindow(
  document: WrappableDocument,
  scrollTop: number,
  wrapWidth: number,
  height: number,
): VisualRow[] {
  const rows: VisualRow[] = [];
  const firstLine = Math.max(0, scrollTop);
  for (let lineIndex = firstLine; lineIndex < document.lineCount && rows.length < height; lineIndex++) {
    const segments = $wrapLine(document.line(lineIndex), wrapWidth);
    for (let segmentIndex = 0; segmentIndex < segments.length && rows.length < height; segmentIndex++) {
      const segment = segments[segmentIndex];
      if (!segment) break;
      rows.push({ lineIndex, segmentIndex, segment, firstOfLine: segmentIndex === 0 });
    }
  }
  return rows;
}

/**
 * Vertical movement by VISUAL rows: step `deltaRows` rows from (line, col), landing at the goal
 * visual column WITHIN the target row (clamped into that row's grapheme range). The goal is
 * row-relative — the wrapped twin of the display-column goal. Clamps at the document's first and
 * last visual rows.
 */
function $moveByVisualRows(
  document: WrappableDocument,
  position: { line: number; col: number },
  goalVisualColumn: number,
  deltaRows: number,
  wrapWidth: number,
): { line: number; col: number } {
  let lineIndex = Math.max(0, Math.min(position.line, document.lineCount - 1));
  let segments = $wrapLine(document.line(lineIndex), wrapWidth);
  let segmentIndex = $segmentIndexForCursor(segments, position.col);
  let remaining = deltaRows;
  while (remaining > 0) {
    if (segmentIndex + 1 < segments.length) {
      segmentIndex += 1;
    } else if (lineIndex < document.lineCount - 1) {
      lineIndex += 1;
      segments = $wrapLine(document.line(lineIndex), wrapWidth);
      segmentIndex = 0;
    } else {
      break;
    }
    remaining -= 1;
  }
  while (remaining < 0) {
    if (segmentIndex > 0) {
      segmentIndex -= 1;
    } else if (lineIndex > 0) {
      lineIndex -= 1;
      segments = $wrapLine(document.line(lineIndex), wrapWidth);
      segmentIndex = segments.length - 1;
    } else {
      break;
    }
    remaining += 1;
  }
  const segment = segments[segmentIndex];
  if (!segment) return { line: lineIndex, col: 0 };
  const lineText = document.line(lineIndex);
  const landing = graphemeAtDisplayColumn(
    lineText,
    segment.startDisplayColumn + Math.max(0, goalVisualColumn),
  );
  // Clamp INTO the row: on a non-last segment the boundary column belongs to the next row, so the
  // landing stays one grapheme short of it (the movement remains visually one-row-per-step).
  const lastSegment = segmentIndex === segments.length - 1;
  const maxColumn = lastSegment
    ? segment.endGrapheme
    : Math.max(segment.startGrapheme, segment.endGrapheme - 1);
  return {
    line: lineIndex,
    col: Math.max(segment.startGrapheme, Math.min(landing, maxColumn)),
  };
}

/**
 * The smallest scroll adjustment that makes the cursor's visual row visible. `scrollTop` stays a
 * LOGICAL line index (the window starts at that line's first visual row); the walk accounts for
 * tall lines. O(height): a lower bound (every line is ≥ 1 visual row) caps the walk to the
 * window's worth of lines. If a single line wraps taller than the viewport, the line's first rows
 * win (top = that line) — the one case a cursor row can remain below the fold.
 */
function $scrollTopToRevealCursor(
  document: WrappableDocument,
  currentScrollTop: number,
  cursorLine: number,
  cursorSegmentIndex: number,
  wrapWidth: number,
  height: number,
): number {
  if (cursorLine < currentScrollTop) return cursorLine;
  // Lower bound: with ≥1 row per line, a top further than height-1 lines above the cursor can
  // never overflow — start there and only walk the O(height) candidate window.
  let top = Math.max(currentScrollTop, cursorLine - height + 1);
  let rowsThroughCursor = cursorSegmentIndex + 1;
  for (let lineIndex = top; lineIndex < cursorLine; lineIndex++) {
    rowsThroughCursor += $visualRowCount(document.line(lineIndex), wrapWidth);
  }
  while (rowsThroughCursor > height && top < cursorLine) {
    rowsThroughCursor -= $visualRowCount(document.line(top), wrapWidth);
    top += 1;
  }
  return top;
}

/**
 * Total visual rows the whole document occupies at `wrapWidth` — the wrapped scroll EXTENT. This is the
 * scrollbar's scrollSize and the max-scroll basis in wrap mode (a logical line count under-reports it,
 * which is the "scrollbar wrong / can't reach the bottom" bug). O(lines) but every wrapLine is memoized
 * (content-keyed), so after the first pass it is O(lines) memo lookups.
 */
function $totalVisualRows(document: WrappableDocument, wrapWidth: number): number {
  let total = 0;
  for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
    total += $visualRowCount(document.line(lineIndex), wrapWidth);
  }
  return Math.max(1, total);
}

/**
 * The visual-row index of a logical line's FIRST visual row (sum of the visual-row counts of all lines
 * before it). The logical↔visual scroll bridge: maps the cursor's line to its visual offset (scroll-into-
 * view) and a logical scrollTop to its visual position (scrollbar thumb). O(lineIndex) memoized.
 */
function $firstVisualRowOfLine(document: WrappableDocument, lineIndex: number, wrapWidth: number): number {
  const clamped = Math.max(0, Math.min(lineIndex, document.lineCount));
  let visualRow = 0;
  for (let index = 0; index < clamped; index++) {
    visualRow += $visualRowCount(document.line(index), wrapWidth);
  }
  return visualRow;
}

/**
 * The (line, segment) at an absolute VISUAL-row offset — the inverse of $firstVisualRowOfLine. Walks
 * lines accumulating their visual-row counts until the offset falls inside a line, then the segment is
 * the remainder. Clamps to the last visual row. O(offset-line) memoized. This is what lets the window
 * start MID-LINE (a tall final line's lower segments become reachable — the true-last-visual-row fix).
 */
function $lineSegmentAtVisualRow(
  document: WrappableDocument,
  visualOffset: number,
  wrapWidth: number,
): { lineIndex: number; segmentIndex: number } {
  const target = Math.max(0, visualOffset);
  let consumed = 0;
  for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
    const count = $visualRowCount(document.line(lineIndex), wrapWidth);
    if (consumed + count > target) {
      return { lineIndex, segmentIndex: target - consumed };
    }
    consumed += count;
  }
  // Past the end: clamp to the last visual row of the last line.
  const lastLine = Math.max(0, document.lineCount - 1);
  const lastCount = $visualRowCount(document.line(lastLine), wrapWidth);
  return { lineIndex: lastLine, segmentIndex: Math.max(0, lastCount - 1) };
}

/**
 * The flyweight window walk from an absolute VISUAL-row offset (not a logical line). The window may
 * start MID-LINE — at any segment — so every visual row, including a tall last line's lower segments, is
 * reachable. O(window) once the start line is located ($lineSegmentAtVisualRow).
 */
function $visualRowsFromOffset(
  document: WrappableDocument,
  visualOffset: number,
  wrapWidth: number,
  height: number,
): VisualRow[] {
  const start = $lineSegmentAtVisualRow(document, visualOffset, wrapWidth);
  const rows: VisualRow[] = [];
  for (let lineIndex = start.lineIndex; lineIndex < document.lineCount && rows.length < height; lineIndex++) {
    const segments = $wrapLine(document.line(lineIndex), wrapWidth);
    const firstSegment = lineIndex === start.lineIndex ? start.segmentIndex : 0;
    for (let segmentIndex = firstSegment; segmentIndex < segments.length && rows.length < height; segmentIndex++) {
      const segment = segments[segmentIndex];
      if (!segment) break;
      rows.push({ lineIndex, segmentIndex, segment, firstOfLine: segmentIndex === 0 });
    }
  }
  return rows;
}

// Stateless capability class (project.conventions.md new-file rule): every operation is a pure
// static, published through the Static() seam like ScrollbarGeometry.
class $EditorWrap {
  /** Wrap one logical line into segment descriptors (word breaks preferred, grapheme-safe). */
  static wrapLine = $wrapLine;
  /** Number of visual rows a logical line occupies at a width. */
  static visualRowCount = $visualRowCount;
  /** The segment a cursor grapheme column belongs to (boundary → NEXT segment). */
  static segmentIndexForCursor = $segmentIndexForCursor;
  /** The O(window) walk of visible visual rows from a logical scrollTop. */
  static visualRowsForWindow = $visualRowsForWindow;
  /** Total visual rows the document occupies (the wrapped scroll extent / scrollbar scrollSize). */
  static totalVisualRows = $totalVisualRows;
  /** Visual-row index of a logical line's first row (logical→visual scroll bridge). */
  static firstVisualRowOfLine = $firstVisualRowOfLine;
  /** The (line, segment) at an absolute visual-row offset (visual→logical; enables mid-line window top). */
  static lineSegmentAtVisualRow = $lineSegmentAtVisualRow;
  /** The O(window) walk of visible visual rows from an absolute VISUAL-row offset (mid-line start ok). */
  static visualRowsFromOffset = $visualRowsFromOffset;
  /** Vertical movement by visual rows with a row-relative goal column. */
  static moveByVisualRows = $moveByVisualRows;
  /** Smallest logical-scrollTop change that reveals the cursor's visual row (O(height)). */
  static scrollTopToRevealCursor = $scrollTopToRevealCursor;
}

export namespace EditorWrap {
  export const $Class = $EditorWrap;
  export const Class = Static($EditorWrap);
}
