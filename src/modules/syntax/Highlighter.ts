// Immediate-layer syntax highlighter: per-line tokenization into semantic role spans.
// This is the fast path that never blocks (Tree-sitter/LSP semantic tokens are the deferred
// upgrade, slotted behind the same LanguageRegistry seam — see KNOWN_LIMITATIONS.md).
//
// invariant: The immediate layer never blocks the deferred layer (project.invariants.md)
// invariant: Cost tracks the actively observed set (project.invariants.md)
//   — only the visible window is tokenized, one line at a time.

import { Static } from 'ivue/extras';

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

export type LangId =
  | 'typescript'
  | 'javascript'
  | 'json'
  | 'markdown'
  | 'html'
  | 'css'
  | 'vue'
  | 'diff'
  | 'plain';

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

/** Tokenize one line of HTML (and, with `vue`, Vue-SFC template sugar: directives + interpolations).
 *  Line-local `insideTag` state, mirroring the block-comment heuristic in tokenizeCode — a tag that
 *  spans lines re-opens its attribute coloring on the next line, which is acceptable for the immediate
 *  layer (the deferred Tree-sitter upgrade is the exact-grammar path). */
function tokenizeHtml(line: string, vue: boolean): Span[] {
  const spans: Span[] = [];
  const push = (text: string, role: Role) => {
    if (text) spans.push({ text, role });
  };
  let index = 0;
  const length = line.length;
  let insideTag = false;
  while (index < length) {
    const character = line[index]!;
    if (!insideTag) {
      // HTML comment (line-local; may not close on this line)
      if (line.startsWith('<!--', index)) {
        const end = line.indexOf('-->', index + 4);
        if (end === -1) {
          push(line.slice(index), 'comment');
          break;
        }
        push(line.slice(index, end + 3), 'comment');
        index = end + 3;
        continue;
      }
      // Vue interpolation {{ expression }}
      if (vue && line.startsWith('{{', index)) {
        const end = line.indexOf('}}', index + 2);
        push('{{', 'operator');
        push(line.slice(index + 2, end === -1 ? length : end), 'variable');
        if (end !== -1) push('}}', 'operator');
        index = end === -1 ? length : end + 2;
        continue;
      }
      // Tag open <tag / close </tag: the bracket is an operator, the tag name a keyword.
      if (character === '<') {
        let scan = index + 1;
        const closing = line[scan] === '/';
        if (closing) scan++;
        push(closing ? '</' : '<', 'operator');
        index = scan;
        const nameStart = index;
        while (index < length && /[A-Za-z0-9-]/.test(line[index]!)) index++;
        push(line.slice(nameStart, index), 'keyword');
        insideTag = true;
        continue;
      }
      // Entity &name; / &#123;
      if (character === '&') {
        const semicolon = line.indexOf(';', index);
        if (semicolon !== -1 && semicolon - index <= 10) {
          push(line.slice(index, semicolon + 1), 'type');
          index = semicolon + 1;
          continue;
        }
        push('&', 'text');
        index++;
        continue;
      }
      // Plain text up to the next tag / entity / interpolation.
      const textStart = index;
      while (
        index < length &&
        line[index] !== '<' &&
        line[index] !== '&' &&
        !(vue && line.startsWith('{{', index))
      ) {
        index++;
      }
      push(line.slice(textStart, index), 'text');
      continue;
    }
    // Inside a tag: close, attribute value, '=', or attribute name.
    if (character === '>') {
      push('>', 'operator');
      insideTag = false;
      index++;
      continue;
    }
    if (character === '/' && line[index + 1] === '>') {
      push('/>', 'operator');
      insideTag = false;
      index += 2;
      continue;
    }
    if (character === '"' || character === "'") {
      let scan = index + 1;
      while (scan < length && line[scan] !== character) scan++;
      push(line.slice(index, Math.min(scan + 1, length)), 'string');
      index = scan + 1;
      continue;
    }
    if (character === '=') {
      push('=', 'operator');
      index++;
      continue;
    }
    if (/[A-Za-z_@:#]/.test(character)) {
      const nameStart = index;
      while (index < length && /[A-Za-z0-9_@:#.\-]/.test(line[index]!)) index++;
      const attribute = line.slice(nameStart, index);
      // Vue directives (v-*, @event, :bind, #slot) pop as keywords; ordinary attributes are variables.
      const isVueDirective = vue && /^(v-|@|:|#)/.test(attribute);
      push(attribute, isVueDirective ? 'keyword' : 'variable');
      continue;
    }
    push(character, 'text');
    index++;
  }
  return spans.length ? spans : [{ text: line, role: 'text' }];
}

/** Tokenize one line of CSS. Line-local (block comments/values that span lines re-color per line).
 *  A property is an identifier immediately followed by ':' (keyword); selectors (.class/#id/@rule) and
 *  values/colors/units get their own roles. */
function tokenizeCss(line: string): Span[] {
  const spans: Span[] = [];
  const push = (text: string, role: Role) => {
    if (text) spans.push({ text, role });
  };
  let index = 0;
  const length = line.length;
  while (index < length) {
    const character = line[index]!;
    // Block comment (line-local)
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
    // String
    if (character === '"' || character === "'") {
      let scan = index + 1;
      while (scan < length && line[scan] !== character) {
        if (line[scan] === '\\') scan++;
        scan++;
      }
      push(line.slice(index, Math.min(scan + 1, length)), 'string');
      index = scan + 1;
      continue;
    }
    // #hex color, else #id selector
    if (character === '#') {
      const hexColor = line.slice(index).match(/^#[0-9a-fA-F]{3,8}\b/);
      if (hexColor) {
        push(hexColor[0], 'number');
        index += hexColor[0].length;
        continue;
      }
      let scan = index + 1;
      while (scan < length && /[A-Za-z0-9_-]/.test(line[scan]!)) scan++;
      push(line.slice(index, scan), 'type');
      index = scan;
      continue;
    }
    // .class selector
    if (character === '.' && /[A-Za-z_-]/.test(line[index + 1] ?? '')) {
      let scan = index + 1;
      while (scan < length && /[A-Za-z0-9_-]/.test(line[scan]!)) scan++;
      push(line.slice(index, scan), 'type');
      index = scan;
      continue;
    }
    // @media / @import at-rule
    if (character === '@') {
      let scan = index + 1;
      while (scan < length && /[A-Za-z-]/.test(line[scan]!)) scan++;
      push(line.slice(index, scan), 'keyword');
      index = scan;
      continue;
    }
    // !important
    if (character === '!') {
      const bang = line.slice(index).match(/^![A-Za-z]+/);
      if (bang) {
        push(bang[0], 'keyword');
        index += bang[0].length;
        continue;
      }
    }
    // number with optional unit
    if (/[0-9]/.test(character) || (character === '-' && /[0-9.]/.test(line[index + 1] ?? ''))) {
      const number = line.slice(index).match(/^-?\d*\.?\d+(px|em|rem|%|vh|vw|vmin|vmax|pt|fr|s|ms|deg)?/);
      if (number) {
        push(number[0], 'number');
        index += number[0].length;
        continue;
      }
    }
    // identifier: a property (followed by ':') is a keyword; otherwise a value/variable
    if (/[A-Za-z_-]/.test(character)) {
      let scan = index;
      while (scan < length && /[A-Za-z0-9_-]/.test(line[scan]!)) scan++;
      const word = line.slice(index, scan);
      let lookAhead = scan;
      while (lookAhead < length && line[lookAhead] === ' ') lookAhead++;
      push(word, line[lookAhead] === ':' ? 'keyword' : 'variable');
      index = scan;
      continue;
    }
    // punctuation
    if (/[{}();:,>+~*=[\]]/.test(character)) {
      push(character, 'operator');
      index++;
      continue;
    }
    push(character, 'text');
    index++;
  }
  return spans.length ? spans : [{ text: line, role: 'text' }];
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
    case 'html':
      return tokenizeHtml(line, false);
    case 'vue':
      return tokenizeHtml(line, true);
    case 'css':
      return tokenizeCss(line);
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
