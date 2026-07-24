// The reusable text-selection seam: a selection over a flat list of visual lines, addressed by
// (line, DISPLAY-CELL column) — the pointer's native unit. It owns ONLY the anchor/focus span and its
// pure geometry (normalized ends, the highlighted cell range on a given line). TEXT RECONSTRUCTION is
// deliberately NOT here: it is surface-specific (transcript visual rows are separate lines joined with
// newlines; composer wraps concatenate with none) and must be grapheme-safe — each surface reconstructs
// through the WrapText display-cell slicer. The old shared selectedText() sliced UTF-16 with cell
// columns (é→"e", emoji→lone surrogate) and forced the composer to suppress it — the wrong-seam tell
// the architecture review named; the seam now carries exactly what is truly shared.
//
// invariant: Seams are drawn at the shared generator (project.invariants.md)
import { Static } from 'ivue/extras';

/** A point in a surface's flat visual-line space: line index + DISPLAY-CELL column. */
export interface SelectionPoint {
  line: number;
  column: number;
}

/** The [start, end) columns of one line covered by the selection. */
export interface SelectionSpanRange {
  start: number;
  end: number;
}

/** Order two points (start ≤ end) by line then column. */
function orderPoints(anchor: SelectionPoint, focus: SelectionPoint): [SelectionPoint, SelectionPoint] {
  const anchorFirst = anchor.line < focus.line || (anchor.line === focus.line && anchor.column <= focus.column);
  return anchorFirst ? [anchor, focus] : [focus, anchor];
}

class $TextSelectionModel {
  private anchor: SelectionPoint | null = null;
  private focus: SelectionPoint | null = null;

  /** Start a selection (anchor === focus until a drag extends it). */
  begin(point: SelectionPoint): void {
    this.anchor = { line: point.line, column: point.column };
    this.focus = { line: point.line, column: point.column };
  }

  /** Move the selection's focus. */
  extend(point: SelectionPoint): void {
    this.focus = { line: point.line, column: point.column };
  }

  /** Finish a drag: a bare click (anchor === focus) leaves no span, so drop it. */
  finish(): void {
    if (this.anchor && this.focus && this.anchor.line === this.focus.line && this.anchor.column === this.focus.column) {
      this.anchor = null;
      this.focus = null;
    }
  }

  /** Drop any selection. Returns true when it actually cleared something. */
  clear(): boolean {
    if (!this.anchor && !this.focus) return false;
    this.anchor = null;
    this.focus = null;
    return true;
  }

  /** The span ordered start ≤ end, or null when there is no anchor/focus. */
  normalized(): [SelectionPoint, SelectionPoint] | null {
    if (!this.anchor || !this.focus) return null;
    return orderPoints(this.anchor, this.focus);
  }

  /** True when a NON-EMPTY span is selected. */
  hasSelection(): boolean {
    const span = this.normalized();
    return span !== null && !(span[0].line === span[1].line && span[0].column === span[1].column);
  }

  /** The [start, end) DISPLAY-CELL columns highlighted on `line` (clamped to the line's cell width), or
   *  null when the line is outside the span/empty. */
  rangeForLine(line: number, lineLength: number): SelectionSpanRange | null {
    const span = this.normalized();
    if (!span || (span[0].line === span[1].line && span[0].column === span[1].column)) return null;
    const [start, end] = span;
    if (line < start.line || line > end.line) return null;
    const startColumn = line === start.line ? start.column : 0;
    const endColumn = line === end.line ? end.column : lineLength;
    const clampedStart = Math.max(0, Math.min(startColumn, lineLength));
    const clampedEnd = Math.max(0, Math.min(endColumn, lineLength));
    if (clampedEnd <= clampedStart) return null;
    return { start: clampedStart, end: clampedEnd };
  }

  /** Reconstruct the selected text through an INJECTED surface resolver: the model walks the covered
   *  lines and asks the surface for each line's grapheme-safe slice over the covered DISPLAY-CELL range
   *  (WrapText.sliceByDisplayCells is the shared slicer); the surface owns the join (transcript rows →
   *  '\n', composer wraps → ''). Null slices (a line the surface no longer has) are skipped. */
  selectedText(
    sliceLine: (line: number, startCell: number, endCell: number | null) => string | null,
    joiner: string,
  ): string {
    const span = this.normalized();
    if (!span) return '';
    const [start, end] = span;
    const parts: string[] = [];
    for (let line = start.line; line <= end.line; line += 1) {
      const startCell = line === start.line ? start.column : 0;
      const endCell = line === end.line ? end.column : null; // null = to the line's end
      const sliced = sliceLine(line, startCell, endCell);
      if (sliced !== null) parts.push(sliced);
    }
    return parts.join(joiner);
  }
}

export namespace TextSelectionModel {
  export const $Class = $TextSelectionModel;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}

/** A tiny stateless helper namespace so a surface can wrap+highlight without importing the class. */
class $TextSelectionGeometry {
  static orderPoints = orderPoints;
}
export namespace TextSelectionGeometry {
  export const $Class = $TextSelectionGeometry;
  export const Class = Static($TextSelectionGeometry);
}
