// The reusable text-selection seam: a selection over a flat list of visual lines, addressed by
// (line, column). It owns ONLY the anchor/focus span and the pure geometry every selectable text
// surface needs — normalized ends, the highlighted column range on a given line, and the selected text
// reconstructed from the lines. It holds NO lines of its own (the surface passes them in), so one model
// serves the agent TRANSCRIPT (read-only, viewport-scrolled) and the agent COMPOSER (editable,
// cap-scrolled) identically — one selectable/copyable core, many surfaces, no per-surface drift.
//
// invariant: Seams are drawn at the shared generator (project.invariants.md)
import { Static } from 'ivue/extras';

/** A point in a surface's flat visual-line space: line index + column (grapheme offset). */
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

  /** The [start, end) columns highlighted on `line`, or null when the line is outside the span/empty. */
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

  /** Reconstruct the selected text from the surface's visual lines (joined with newlines). */
  selectedText(lines: readonly string[]): string {
    const span = this.normalized();
    if (!span || lines.length === 0) return '';
    const [start, end] = span;
    const startLine = Math.max(0, Math.min(start.line, lines.length - 1));
    const endLine = Math.max(0, Math.min(end.line, lines.length - 1));
    if (startLine === endLine) return (lines[startLine] ?? '').slice(start.column, end.column);
    const parts: string[] = [(lines[startLine] ?? '').slice(start.column)];
    for (let line = startLine + 1; line < endLine; line += 1) parts.push(lines[line] ?? '');
    parts.push((lines[endLine] ?? '').slice(0, end.column));
    return parts.join('\n');
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
