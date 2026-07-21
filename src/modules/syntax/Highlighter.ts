// Immediate-layer syntax highlighter: per-line tokenization into semantic role spans.
// This is the fast path that never blocks (Tree-sitter/LSP semantic tokens are the deferred
// upgrade, slotted behind the same LanguageRegistry seam — see KNOWN_LIMITATIONS.md).
//
// invariant: The immediate layer never blocks the deferred layer (project.invariants.md)
// invariant: Cost tracks the actively observed set (project.invariants.md)
//   — only the visible window is tokenized, one line at a time.

export type Role =
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'func'
  | 'type'
  | 'operator'
  | 'variable'
  | 'text';

export interface Span {
  text: string;
  role: Role;
}

export type LangId = 'typescript' | 'javascript' | 'json' | 'markdown' | 'plain';

const TS_KEYWORDS = new Set([
  'abstract', 'any', 'as', 'async', 'await', 'boolean', 'break', 'case', 'catch', 'class',
  'const', 'continue', 'debugger', 'declare', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get', 'if',
  'implements', 'import', 'in', 'infer', 'instanceof', 'interface', 'is', 'keyof', 'let',
  'namespace', 'never', 'new', 'null', 'number', 'object', 'of', 'private', 'protected',
  'public', 'readonly', 'return', 'satisfies', 'set', 'static', 'string', 'super', 'switch',
  'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'unknown', 'var', 'void',
  'while', 'yield',
]);

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}
function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

/** Tokenize a single line of TS/JS into role spans. Line-local (no cross-line block state). */
function tokenizeCode(line: string): Span[] {
  const spans: Span[] = [];
  let i = 0;
  const n = line.length;
  const push = (text: string, role: Role) => {
    if (text) spans.push({ text, role });
  };
  while (i < n) {
    const ch = line[i]!;
    // line comment
    if (ch === '/' && line[i + 1] === '/') {
      push(line.slice(i), 'comment');
      break;
    }
    // block comment (line-local; opens and may not close on this line)
    if (ch === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2);
      if (end === -1) {
        push(line.slice(i), 'comment');
        break;
      }
      push(line.slice(i, end + 2), 'comment');
      i = end + 2;
      continue;
    }
    // strings
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < n && line[j] !== ch) {
        if (line[j] === '\\') j++;
        j++;
      }
      push(line.slice(i, Math.min(j + 1, n)), 'string');
      i = j + 1;
      continue;
    }
    // numbers
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9a-fA-FxX._]/.test(line[j]!)) j++;
      push(line.slice(i, j), 'number');
      i = j;
      continue;
    }
    // identifiers / keywords / types / functions
    if (isIdentStart(ch)) {
      let j = i;
      while (j < n && isIdentPart(line[j]!)) j++;
      const word = line.slice(i, j);
      let role: Role = 'variable';
      if (TS_KEYWORDS.has(word)) role = 'keyword';
      else if (/^[A-Z]/.test(word)) role = 'type';
      else if (line[j] === '(') role = 'func';
      push(word, role);
      i = j;
      continue;
    }
    // operators / punctuation
    if (/[+\-*/%=<>!&|^~?:.,;(){}\[\]]/.test(ch)) {
      push(ch, 'operator');
      i++;
      continue;
    }
    // whitespace / other
    push(ch, 'text');
    i++;
  }
  return spans.length ? spans : [{ text: line, role: 'text' }];
}

function tokenizeJson(line: string): Span[] {
  const spans: Span[] = [];
  const re = /("(?:[^"\\]|\\.)*"\s*:)|("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([{}\[\],:])|(\s+)|(.)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m[1]) spans.push({ text: m[1], role: 'type' }); // key
    else if (m[2]) spans.push({ text: m[2], role: 'string' });
    else if (m[3]) spans.push({ text: m[3], role: 'number' });
    else if (m[4]) spans.push({ text: m[4], role: 'keyword' });
    else if (m[5]) spans.push({ text: m[5], role: 'operator' });
    else spans.push({ text: m[0], role: 'text' });
  }
  return spans.length ? spans : [{ text: line, role: 'text' }];
}

function tokenizeMarkdown(line: string): Span[] {
  if (/^\s*#{1,6}\s/.test(line)) return [{ text: line, role: 'keyword' }];
  if (/^\s*([-*+]|\d+\.)\s/.test(line)) {
    const m = line.match(/^(\s*(?:[-*+]|\d+\.)\s)(.*)$/);
    if (m) return [{ text: m[1]!, role: 'operator' }, { text: m[2]!, role: 'text' }];
  }
  if (/^\s*>/.test(line)) return [{ text: line, role: 'comment' }];
  if (/^\s*```/.test(line)) return [{ text: line, role: 'string' }];
  // inline code
  if (line.includes('`')) {
    const spans: Span[] = [];
    let rest = line;
    const re = /`[^`]*`/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      if (m.index > last) spans.push({ text: line.slice(last, m.index), role: 'text' });
      spans.push({ text: m[0], role: 'string' });
      last = m.index + m[0].length;
    }
    if (last < line.length) spans.push({ text: line.slice(last), role: 'text' });
    return spans.length ? spans : [{ text: line, role: 'text' }];
  }
  return [{ text: line, role: 'text' }];
}

export function highlightLine(line: string, lang: LangId): Span[] {
  switch (lang) {
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
