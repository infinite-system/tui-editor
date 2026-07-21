// Immediate-layer syntax highlighter: per-line tokenization into semantic role spans.
// This is the fast path that never blocks (Tree-sitter/LSP semantic tokens are the deferred
// upgrade, slotted behind the same LanguageRegistry seam — see KNOWN_LIMITATIONS.md).
//
// invariant: The immediate layer never blocks the deferred layer (project.invariants.md)
// invariant: Cost tracks the actively observed set (project.invariants.md)
//   — only the visible window is tokenized, one line at a time.

import { Static } from '../system/Static';

export type Role =
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'func'
  | 'type'
  | 'operator'
  | 'variable'
  | 'added'
  | 'removed'
  | 'text';

export interface Span {
  text: string;
  role: Role;
}

export type LangId = 'typescript' | 'javascript' | 'json' | 'markdown' | 'diff' | 'plain';

const TYPESCRIPT_KEYWORDS = new Set([
  'abstract', 'any', 'as', 'async', 'await', 'boolean', 'break', 'case', 'catch', 'class',
  'const', 'continue', 'debugger', 'declare', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get', 'if',
  'implements', 'import', 'in', 'infer', 'instanceof', 'interface', 'is', 'keyof', 'let',
  'namespace', 'never', 'new', 'null', 'number', 'object', 'of', 'private', 'protected',
  'public', 'readonly', 'return', 'satisfies', 'set', 'static', 'string', 'super', 'switch',
  'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'unknown', 'var', 'void',
  'while', 'yield',
]);

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_$]/.test(character);
}
function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_$]/.test(character);
}

/** Tokenize a single line of TS/JS into role spans. Line-local (no cross-line block state). */
function tokenizeCode(line: string): Span[] {
  const spans: Span[] = [];
  let index = 0;
  const length = line.length;
  const push = (text: string, role: Role) => {
    if (text) spans.push({ text, role });
  };
  while (index < length) {
    const character = line[index]!;
    // line comment
    if (character === '/' && line[index + 1] === '/') {
      push(line.slice(index), 'comment');
      break;
    }
    // block comment (line-local; opens and may not close on this line)
    if (character === '/' && line[index + 1] === '*') {
      const end = line.indexOf('*/', index + 2);
      if (end === -1) {
        push(line.slice(index), 'comment');
        break;
      }
      push(line.slice(index, end + 2), 'comment');
      index = end + 2;
      continue;
    }
    // strings
    if (character === '"' || character === "'" || character === '`') {
      let scanIndex = index + 1;
      while (scanIndex < length && line[scanIndex] !== character) {
        if (line[scanIndex] === '\\') scanIndex++;
        scanIndex++;
      }
      push(line.slice(index, Math.min(scanIndex + 1, length)), 'string');
      index = scanIndex + 1;
      continue;
    }
    // numbers
    if (/[0-9]/.test(character)) {
      let scanIndex = index;
      while (scanIndex < length && /[0-9a-fA-FxX._]/.test(line[scanIndex]!)) scanIndex++;
      push(line.slice(index, scanIndex), 'number');
      index = scanIndex;
      continue;
    }
    // identifiers / keywords / types / functions
    if (isIdentifierStart(character)) {
      let scanIndex = index;
      while (scanIndex < length && isIdentifierPart(line[scanIndex]!)) scanIndex++;
      const word = line.slice(index, scanIndex);
      let role: Role = 'variable';
      if (TYPESCRIPT_KEYWORDS.has(word)) role = 'keyword';
      else if (/^[A-Z]/.test(word)) role = 'type';
      else if (line[scanIndex] === '(') role = 'func';
      push(word, role);
      index = scanIndex;
      continue;
    }
    // operators / punctuation
    if (/[+\-*/%=<>!&|^~?:.,;(){}\[\]]/.test(character)) {
      push(character, 'operator');
      index++;
      continue;
    }
    // whitespace / other
    push(character, 'text');
    index++;
  }
  return spans.length ? spans : [{ text: line, role: 'text' }];
}

function tokenizeJson(line: string): Span[] {
  const spans: Span[] = [];
  const pattern = /("(?:[^"\\]|\\.)*"\s*:)|("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([{}\[\],:])|(\s+)|(.)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) {
    if (match[1]) spans.push({ text: match[1], role: 'type' }); // key
    else if (match[2]) spans.push({ text: match[2], role: 'string' });
    else if (match[3]) spans.push({ text: match[3], role: 'number' });
    else if (match[4]) spans.push({ text: match[4], role: 'keyword' });
    else if (match[5]) spans.push({ text: match[5], role: 'operator' });
    else spans.push({ text: match[0], role: 'text' });
  }
  return spans.length ? spans : [{ text: line, role: 'text' }];
}

function tokenizeMarkdown(line: string): Span[] {
  if (/^\s*#{1,6}\s/.test(line)) return [{ text: line, role: 'keyword' }];
  if (/^\s*([-*+]|\d+\.)\s/.test(line)) {
    const match = line.match(/^(\s*(?:[-*+]|\d+\.)\s)(.*)$/);
    if (match) return [{ text: match[1]!, role: 'operator' }, { text: match[2]!, role: 'text' }];
  }
  if (/^\s*>/.test(line)) return [{ text: line, role: 'comment' }];
  if (/^\s*```/.test(line)) return [{ text: line, role: 'string' }];
  // inline code
  if (line.includes('`')) {
    const spans: Span[] = [];
    let rest = line;
    const pattern = /`[^`]*`/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line))) {
      if (match.index > lastIndex) spans.push({ text: line.slice(lastIndex, match.index), role: 'text' });
      spans.push({ text: match[0], role: 'string' });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < line.length) spans.push({ text: line.slice(lastIndex), role: 'text' });
    return spans.length ? spans : [{ text: line, role: 'text' }];
  }
  return [{ text: line, role: 'text' }];
}

function $highlightLine(line: string, language: LangId): Span[] {
  if (language === 'diff') {
    // Line-level diff coloring: whole-line roles keyed by the unified-diff prefix.
    if (line.startsWith('+')) return [{ text: line, role: 'added' }];
    if (line.startsWith('-')) return [{ text: line, role: 'removed' }];
    if (line.startsWith('@@')) return [{ text: line, role: 'func' }];
    if (line.startsWith('diff ') || line.startsWith('index ')) return [{ text: line, role: 'comment' }];
    return [{ text: line, role: 'text' }];
  }
  switch (language) {
    case 'typescript':
    case 'javascript':
      return tokenizeCode(line);
    case 'json':
      return tokenizeJson(line);
    case 'markdown':
      return tokenizeMarkdown(line);
    default:
      return [{ text: line, role: 'text' }];
  }
}

class $Highlighter {
  static highlightLine = $highlightLine;
}

export namespace Highlighter {
  export const $Class = $Highlighter;
  export const Class = Static($Highlighter);
}
