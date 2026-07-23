// The bracket finder: the pure core with injected cells + predicate (nesting, adjacency, multi-line,
// unbalanced, same-family, string/comment skip, scan cap), plus one findInDocument test that proves the
// real syntax tokenizer skips a bracket inside a string.
import { test, expect } from 'bun:test';
import { BracketMatch, type BracketMatchQuery } from './BracketMatch';
import { TextDocument } from './TextDocument';

function query(lines: string[], cursorLine: number, cursorColumn: number, options?: Partial<BracketMatchQuery>): BracketMatchQuery {
  const cells = lines.map((line) => Array.from(line));
  return {
    cursorLine,
    cursorColumn,
    lineCount: lines.length,
    cellsAt: (index) => (index >= 0 && index < cells.length ? cells[index]! : null),
    isCodeBracket: options?.isCodeBracket ?? (() => true),
    maxScanCells: options?.maxScanCells,
  };
}

test('cursor ON an opener matches its closer', () => {
  expect(BracketMatch.Class.find(query(['(a + b)'], 0, 0))).toEqual({ bracket: { line: 0, column: 0 }, match: { line: 0, column: 6 } });
});

test('cursor immediately AFTER a closer matches its opener', () => {
  // column 3 is past the last cell of "(a)"; the finder falls back to the cell before the cursor.
  expect(BracketMatch.Class.find(query(['(a)'], 0, 3))).toEqual({ bracket: { line: 0, column: 2 }, match: { line: 0, column: 0 } });
});

test('nested same-family brackets balance by depth', () => {
  // ((())) — the opener at col 1 closes at col 4.
  expect(BracketMatch.Class.find(query(['((()))'], 0, 1))?.match).toEqual({ line: 0, column: 4 });
});

test('different families nest transparently', () => {
  // {[()]} — the outer '{' matches the outer '}', ignoring the inner [ ( ) ].
  expect(BracketMatch.Class.find(query(['{[()]}'], 0, 0))?.match).toEqual({ line: 0, column: 5 });
});

test('matching is per-family (a mismatched inner bracket is ignored)', () => {
  // ([)] — '(' matches the FIRST ')' of its family, ignoring the '['.
  expect(BracketMatch.Class.find(query(['([)]'], 0, 0))?.match).toEqual({ line: 0, column: 2 });
});

test('matches across multiple lines', () => {
  const lines = ['function f() {', '  return 1;', '}'];
  // the '{' is the last non-space cell of line 0 (column 13); it closes on line 2, column 0.
  expect(BracketMatch.Class.find(query(lines, 0, 13))?.match).toEqual({ line: 2, column: 0 });
});

test('an unbalanced bracket yields no match', () => {
  expect(BracketMatch.Class.find(query(['(('], 0, 0))).toBeNull();
});

test('a non-bracket cursor position yields no match', () => {
  expect(BracketMatch.Class.find(query(['abc'], 0, 1))).toBeNull();
});

test('a bracket the predicate rejects (string/comment) is skipped during the scan', () => {
  // "( ) )": the ')' at column 2 is "inside a string" (predicate false) → skipped; matches col 4.
  const isCodeBracket = (_line: number, column: number) => column !== 2;
  expect(BracketMatch.Class.find(query(['( ) )'], 0, 0, { isCodeBracket }))?.match).toEqual({ line: 0, column: 4 });
});

test('a cursor bracket the predicate rejects is not matched at all', () => {
  const isCodeBracket = () => false; // the cursor bracket itself is "in a string"
  expect(BracketMatch.Class.find(query(['(a)'], 0, 0, { isCodeBracket }))).toBeNull();
});

test('the scan cap bounds a pathological unbalanced file (no hang, no match)', () => {
  const lines = ['(' + ' '.repeat(1000)];
  expect(BracketMatch.Class.find(query(lines, 0, 0, { maxScanCells: 10 }))).toBeNull();
});

test('findInDocument skips a bracket inside a string via the real tokenizer', () => {
  const document = new TextDocument.Class();
  document.loadFromText('f( "a)b" )');
  // cursor on the real opening '(' at column 1. Naive raw-balance would match the ')' inside the
  // string "a)b" (column 5); the operator-role gate skips it and matches the real ')' at column 9.
  const result = BracketMatch.Class.findInDocument(document, 0, 1, 'typescript');
  expect(result?.match).toEqual({ line: 0, column: 9 });
});
