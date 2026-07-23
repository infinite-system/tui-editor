// Bracket matching (editor parity): given the cursor position, find the bracket the cursor is ON or
// immediately AFTER, and its balanced partner. The core `find` is PURE — it takes grapheme cells per
// line and a predicate for "is this bracket real code" — so it is exhaustively unit-testable with plain
// arrays. `findInDocument` is the thin wiring that backs the predicate with the per-line syntax
// tokenizer (a bracket counts only when its span role is `operator`, which skips brackets inside
// strings and comments) and supplies the document's grapheme cells.
//
// BOUNDED: the scan is capped (a pathological unbalanced file can never hang) and matches by the
// SAME bracket family (a `(` counts only `(`/`)`), the standard editor behaviour.
//
// LIMITATION (flagged): the tokenizer is line-local, so a string or block comment that SPANS lines is
// not tracked across the newline; a bracket inside such a multi-line construct may still be matched.
// Single-line strings/comments (the common case) are correctly skipped.
//
// invariant: A matched bracket pair is balanced within the same family (src/modules/editor/editor.invariants.md)
// invariant: Bracket matching skips brackets inside strings and comments (src/modules/editor/editor.invariants.md)
import { Static } from 'ivue/extras';
import { EditorCoordinates } from './EditorCoordinates';
import { Highlighter, type Span } from '../syntax/Highlighter';
import type { TextDocument } from './TextDocument';
import type { LangId } from '../syntax/Highlighter';

const OPENERS = '([{';
const CLOSERS = ')]}';
const PARTNER: Record<string, string> = { '(': ')', '[': ']', '{': '}', ')': '(', ']': '[', '}': '{' };
const DEFAULT_MAX_SCAN_CELLS = 100_000;

/** A cell position: 0-based line and 0-based grapheme column. */
export interface BracketCell {
  readonly line: number;
  readonly column: number;
}

/** The cursor's bracket and its balanced partner. */
export interface BracketMatchResult {
  readonly bracket: BracketCell;
  readonly match: BracketCell;
}

/** Everything the pure finder needs — injected so tests drive it with plain arrays. */
export interface BracketMatchQuery {
  readonly cursorLine: number;
  readonly cursorColumn: number;
  readonly lineCount: number;
  /** The grapheme cells of a line, or null when the index is out of range. */
  cellsAt(lineIndex: number): readonly string[] | null;
  /** Whether the bracket at (line, column) is real code — false inside a string/comment. */
  isCodeBracket(lineIndex: number, column: number): boolean;
  /** Cap on cells scanned before giving up (prevents a hang on a pathological unbalanced file). */
  readonly maxScanCells?: number;
}

function isBracketChar(cell: string | undefined): cell is string {
  return cell !== undefined && cell.length === 1 && (OPENERS.includes(cell) || CLOSERS.includes(cell));
}

class $BracketMatch {
  /** Pure balanced-partner finder. Returns the cursor's bracket + its match, or null when the cursor is
   *  not on/after a code bracket, the pair is unbalanced, or the scan cap is hit. */
  static find(query: BracketMatchQuery): BracketMatchResult | null {
    const cursorCells = query.cellsAt(query.cursorLine);
    if (!cursorCells) return null;

    // Locate the active bracket: the cell UNDER the cursor first, then the cell immediately BEFORE it
    // (so a cursor sitting just past a closing bracket still matches). Must be a real code bracket.
    let column = query.cursorColumn;
    let cell = cursorCells[column];
    if (!isBracketChar(cell) || !query.isCodeBracket(query.cursorLine, column)) {
      column = query.cursorColumn - 1;
      cell = cursorCells[column];
      if (column < 0 || !isBracketChar(cell) || !query.isCodeBracket(query.cursorLine, column)) return null;
    }

    const bracketCharacter = cell as string;
    const partner = PARTNER[bracketCharacter]!;
    const forward = OPENERS.includes(bracketCharacter); // opener scans forward, closer scans backward
    const step = forward ? 1 : -1;
    const cap = query.maxScanCells ?? DEFAULT_MAX_SCAN_CELLS;

    let line = query.cursorLine;
    let scanColumn = column;
    let cells: readonly string[] | null = cursorCells;
    let depth = 0;
    for (let scanned = 0; scanned < cap; scanned += 1) {
      // Advance one cell in the scan direction, crossing (possibly empty) line boundaries.
      scanColumn += step;
      if (forward) {
        while (cells && scanColumn >= cells.length) {
          line += 1;
          if (line >= query.lineCount) return null;
          cells = query.cellsAt(line);
          scanColumn = 0;
        }
      } else {
        while (cells && scanColumn < 0) {
          line -= 1;
          if (line < 0) return null;
          cells = query.cellsAt(line);
          scanColumn = cells ? cells.length - 1 : 0;
        }
      }
      if (!cells) return null;
      if (cells.length === 0) continue; // empty line: the while advanced `line`; nothing to inspect

      const scanCell = cells[scanColumn];
      if (!isBracketChar(scanCell) || !query.isCodeBracket(line, scanColumn)) continue;
      if (scanCell === bracketCharacter) {
        depth += 1; // a nested bracket of the same kind
      } else if (scanCell === partner) {
        if (depth === 0) return { bracket: { line: query.cursorLine, column }, match: { line, column: scanColumn } };
        depth -= 1;
      }
    }
    return null; // scan cap hit → treat as no match (bounded, never hangs)
  }

  /** Wire the pure finder to a live document: grapheme cells per line, and an operator-role predicate
   *  (skips string/comment brackets) backed by the per-line tokenizer. Plain text has no strings/
   *  comments to worry about, so every bracket counts there. */
  static findInDocument(
    document: TextDocument.Instance,
    cursorLine: number,
    cursorColumn: number,
    language: LangId,
  ): BracketMatchResult | null {
    const cellsMemo = new Map<number, readonly string[] | null>();
    const spansMemo = new Map<number, Span[]>();
    const cellsAt = (lineIndex: number): readonly string[] | null => {
      if (lineIndex < 0 || lineIndex >= document.lineCount) return null;
      if (!cellsMemo.has(lineIndex)) cellsMemo.set(lineIndex, EditorCoordinates.Class.graphemes(document.line(lineIndex)));
      return cellsMemo.get(lineIndex) ?? null;
    };
    const isCodeBracket = (lineIndex: number, column: number): boolean => {
      if (language === 'plain') return true; // no strings/comments to exclude in plain text
      const text = document.line(lineIndex);
      if (!spansMemo.has(lineIndex)) spansMemo.set(lineIndex, Highlighter.Class.highlightLine(text, language));
      const spans = spansMemo.get(lineIndex)!;
      const utf16 = EditorCoordinates.Class.graphemeToU16(text, column);
      let accumulated = 0;
      for (const span of spans) {
        if (utf16 >= accumulated && utf16 < accumulated + span.text.length) return span.role === 'operator';
        accumulated += span.text.length;
      }
      return true; // past the last classified span → treat as code
    };
    return $BracketMatch.find({ cursorLine, cursorColumn, lineCount: document.lineCount, cellsAt, isCodeBracket });
  }
}

export namespace BracketMatch {
  export const $Class = $BracketMatch;
  export const Class = Static($BracketMatch);
}
