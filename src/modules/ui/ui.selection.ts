// Selection-aware line rendering: turn a line's syntax spans into styled chunks, shading the
// selected grapheme range with a background while preserving each span's foreground. Pure and
// grapheme-correct (splits on grapheme boundaries via editor.coordinates, never inside a
// surrogate pair or a combined emoji), so it is unit-testable without a renderer.
import { fg, bg, type TextChunk } from '@opentui/core';
import { graphemeCount, graphemeToU16 } from '../editor/editor.coordinates';

export interface Position {
  line: number;
  col: number;
}

export interface SpanColor {
  text: string;
  color: string;
}

/**
 * The selected grapheme-column range `[start, end)` on `lineNo`, or null when the line is outside
 * the selection or the range is empty. Middle lines of a multi-line selection are shaded from
 * column 0 to end-of-content.
 */
export function lineSelectionRange(
  sel: { start: Position; end: Position } | null,
  lineNo: number,
  lineText: string,
): [number, number] | null {
  if (!sel || lineNo < sel.start.line || lineNo > sel.end.line) return null;
  const s = lineNo === sel.start.line ? sel.start.col : 0;
  const e = lineNo === sel.end.line ? sel.end.col : graphemeCount(lineText);
  return e > s ? [s, e] : null;
}

/**
 * Emit each span as a chunk, splitting spans that straddle `selRange` so the selected slice
 * carries `selBg` as a background (its foreground is preserved because applyStyle merges fg + bg).
 */
export function buildSelectedSpans(
  spans: SpanColor[],
  selRange: [number, number] | null,
  selBg: string,
): TextChunk[] {
  const out: TextChunk[] = [];
  let col = 0;
  for (const span of spans) {
    const spanStart = col;
    const spanEnd = col + graphemeCount(span.text);
    col = spanEnd;
    if (!selRange) {
      out.push(fg(span.color)(span.text));
      continue;
    }
    const oStart = Math.max(spanStart, selRange[0]);
    const oEnd = Math.min(spanEnd, selRange[1]);
    if (oStart >= oEnd) {
      out.push(fg(span.color)(span.text));
      continue;
    }
    const a = graphemeToU16(span.text, oStart - spanStart);
    const b = graphemeToU16(span.text, oEnd - spanStart);
    const before = span.text.slice(0, a);
    const mid = span.text.slice(a, b);
    const after = span.text.slice(b);
    if (before) out.push(fg(span.color)(before));
    if (mid) out.push(bg(selBg)(fg(span.color)(mid)));
    if (after) out.push(fg(span.color)(after));
  }
  return out;
}
