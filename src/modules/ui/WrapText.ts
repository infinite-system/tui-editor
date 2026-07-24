// The shared text-GEOMETRY seam: hard-wrap segmentation measured in terminal DISPLAY CELLS over
// GRAPHEME CLUSTERS, with the forward/inverse position mapping every consumer derives caret, selection,
// and hit-test behavior from. One generator (built on EditorCoordinates' grapheme + wcwidth tools — the
// editor's own width engine, not a second vocabulary) serves the agent transcript (read-only) and the
// composer (editable), so their wrapping and their GEOMETRY can never drift — the review-found bug class
// was exactly this drift: code-point wrapping let CJK overflow panes, split combining marks across rows,
// and made the composer's uniform-width caret math disagree with the rendered rows.
//
// Semantics: a grapheme cluster is NEVER split across a wrap boundary; widths are wcwidth-approximate
// display cells (CJK/emoji = 2, combining marks = 0 within their cluster); '\t' measures as 1 cell here
// (wrapped panes have no tab-stop contract — what matters is that wrap, slice, clip, and caret all use
// the SAME measure). Explicit newlines start a new logical line; an empty logical line yields one empty
// visual segment (blank lines are preserved).
//
// invariant: Seams are drawn at the shared generator (project.invariants.md)
import { Static } from 'ivue/extras';
import { EditorCoordinates } from '../editor/EditorCoordinates';

/** One wrapped visual row, with the geometry that generated it. */
export interface WrapSegment {
  /** The row's text (whole grapheme clusters). */
  readonly text: string;
  /** Which logical line (newline-split) this row belongs to. */
  readonly logicalLine: number;
  /** True for the first row of its logical line. */
  readonly isLogicalLineStart: boolean;
  /** Grapheme offset of this row's first cluster within the WHOLE text (newlines counted as 1). */
  readonly graphemeStart: number;
  /** Grapheme clusters in this row. */
  readonly graphemeCount: number;
  /** Display cells this row occupies. */
  readonly displayWidth: number;
}

/** A caret/selection position in wrapped visual space: row index + DISPLAY-CELL column. */
export interface VisualPosition {
  readonly line: number;
  readonly column: number;
}

/** Display width of one grapheme cluster under THIS seam's measure ('\t' = 1 cell, no tab stops). */
function cellWidthOf(cluster: string): number {
  return cluster === '\t' ? 1 : EditorCoordinates.Class.graphemeWidth(cluster);
}

/** Total display cells of a string under this seam's measure. */
function $displayWidth(text: string): number {
  let width = 0;
  for (const cluster of EditorCoordinates.Class.graphemes(text)) width += cellWidthOf(cluster);
  return width;
}

/** Wrap `text` into visual segments no wider than `width` display cells. A cluster wider than the
 *  budget (a CJK cell at width 1) still gets its own row — progress is guaranteed, never a split. */
function $segments(text: string, width: number): WrapSegment[] {
  const out: WrapSegment[] = [];
  const budget = Math.max(1, width);
  let graphemeOffset = 0;
  const logicalLines = text.split('\n');
  logicalLines.forEach((logicalLine, logicalIndex) => {
    const clusters = EditorCoordinates.Class.graphemes(logicalLine);
    if (clusters.length === 0) {
      out.push({ text: '', logicalLine: logicalIndex, isLogicalLineStart: true, graphemeStart: graphemeOffset, graphemeCount: 0, displayWidth: 0 });
    } else {
      let rowText = '';
      let rowStart = graphemeOffset;
      let rowCount = 0;
      let rowWidth = 0;
      let firstRow = true;
      const flush = (): void => {
        out.push({ text: rowText, logicalLine: logicalIndex, isLogicalLineStart: firstRow, graphemeStart: rowStart, graphemeCount: rowCount, displayWidth: rowWidth });
        firstRow = false;
        rowText = '';
        rowStart = rowStart + rowCount;
        rowCount = 0;
        rowWidth = 0;
      };
      for (const cluster of clusters) {
        const clusterWidth = cellWidthOf(cluster);
        if (rowCount > 0 && rowWidth + clusterWidth > budget) flush();
        rowText += cluster;
        rowCount += 1;
        rowWidth += clusterWidth;
      }
      flush();
    }
    graphemeOffset += clusters.length + 1; // +1 for the newline position between logical lines
  });
  return out;
}

/** Wrap to plain row strings (the simple projection most render paths need). */
function $wrap(text: string, width: number): string[] {
  return $segments(text, width).map((segment) => segment.text);
}

/** FORWARD mapping: the visual (row, display-column) of grapheme offset `graphemeIndex` (whole-text
 *  offsets, matching WrapSegment.graphemeStart). An offset ON a wrap boundary maps to the START of the
 *  following row (mid-line), or to the END of the last row (text end) — the caret convention. */
function $visualPositionOf(segments: readonly WrapSegment[], graphemeIndex: number): VisualPosition {
  if (segments.length === 0) return { line: 0, column: 0 };
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const endOffset = segment.graphemeStart + segment.graphemeCount;
    const isLast = index === segments.length - 1;
    const nextContinuesLine = !isLast && !segments[index + 1]!.isLogicalLineStart;
    // Inside this row, or at its end when nothing continues the same logical line after it.
    if (graphemeIndex < endOffset || (graphemeIndex === endOffset && (!nextContinuesLine || isLast))) {
      const within = Math.max(0, graphemeIndex - segment.graphemeStart);
      return { line: index, column: $displayWidth(EditorCoordinates.Class.graphemes(segment.text).slice(0, within).join('')) };
    }
  }
  const last = segments[segments.length - 1]!;
  return { line: segments.length - 1, column: last.displayWidth };
}

/** INVERSE mapping: the whole-text grapheme offset at visual (row, display-column). The column snaps to
 *  the nearest cluster START at or before it, clamped into the row. */
function $graphemeAtVisualPosition(segments: readonly WrapSegment[], line: number, column: number): number {
  if (segments.length === 0) return 0;
  const rowIndex = Math.max(0, Math.min(line, segments.length - 1));
  const segment = segments[rowIndex]!;
  const clusters = EditorCoordinates.Class.graphemes(segment.text);
  let cells = 0;
  for (let index = 0; index < clusters.length; index += 1) {
    const clusterWidth = cellWidthOf(clusters[index]!);
    if (cells + clusterWidth > Math.max(0, column)) return segment.graphemeStart + index;
    cells += clusterWidth;
  }
  return segment.graphemeStart + clusters.length;
}

/** Slice `text` by DISPLAY-CELL range [startCell, endCell) — grapheme-safe (never a half surrogate or a
 *  detached combining mark). A wide cluster straddling an edge is included when its START cell is inside
 *  the range. The shared slicer for selection highlight + reconstruction on BOTH text surfaces. */
function $sliceByDisplayCells(text: string, startCell: number, endCell: number): string {
  if (endCell <= startCell) return '';
  const clusters = EditorCoordinates.Class.graphemes(text);
  let cells = 0;
  let sliced = '';
  for (const cluster of clusters) {
    const clusterWidth = cellWidthOf(cluster);
    if (cells >= endCell) break;
    if (cells >= startCell) sliced += cluster;
    cells += clusterWidth;
  }
  return sliced;
}

/** Clip `text` to at most `cells` display cells, appending `ellipsis` when it overflows (the ellipsis'
 *  own width is budgeted so the result NEVER exceeds `cells`). */
function $clipToWidth(text: string, cells: number, ellipsis = '…'): string {
  if (cells <= 0) return '';
  if ($displayWidth(text) <= cells) return text;
  const ellipsisWidth = $displayWidth(ellipsis);
  return $sliceByDisplayCells(text, 0, Math.max(0, cells - ellipsisWidth)) + ellipsis;
}

class $WrapText {
  static wrap = $wrap;
  static segments = $segments;
  static displayWidth = $displayWidth;
  static visualPositionOf = $visualPositionOf;
  static graphemeAtVisualPosition = $graphemeAtVisualPosition;
  static sliceByDisplayCells = $sliceByDisplayCells;
  static clipToWidth = $clipToWidth;
}

export namespace WrapText {
  export const $Class = $WrapText;
  export const Class = Static($WrapText);
}
