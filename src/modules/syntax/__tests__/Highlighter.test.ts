import { test, expect } from 'bun:test';
import { highlightLine } from '../Highlighter';
import { LanguageRegistry } from '../LanguageRegistry';

const roles = (line: string, language: any) => highlightLine(line, language).map((span) => span.role);
const textOf = (line: string, language: any) => highlightLine(line, language).map((span) => span.text).join('');

test('language registry maps extensions', () => {
  expect(LanguageRegistry.Class.forPath('a/b.ts')).toBe('typescript');
  expect(LanguageRegistry.Class.forPath('x.JSON')).toBe('json');
  expect(LanguageRegistry.Class.forPath('r.md')).toBe('markdown');
  expect(LanguageRegistry.Class.forPath('LICENSE')).toBe('plain');
});

test('tokenizer preserves the exact line text (lossless spans)', () => {
  const line = "const x = foo('bar', 42); // note";
  expect(textOf(line, 'typescript')).toBe(line);
});

test('keywords, strings, numbers, comments get distinct roles', () => {
  const spans = highlightLine("const s = 'hi'; // c", 'typescript');
  const byText = (text: string) => spans.find((span) => span.text === text)?.role;
  expect(byText('const')).toBe('keyword');
  expect(spans.find((span) => span.role === 'string')?.text).toBe("'hi'");
  expect(spans.some((span) => span.role === 'comment' && span.text.includes('// c'))).toBe(true);
});

test('PascalCase identifiers are typed, call sites are funcs', () => {
  const spans = highlightLine('new Widget(); doThing()', 'typescript');
  expect(spans.find((span) => span.text === 'Widget')?.role).toBe('type');
  expect(spans.find((span) => span.text === 'doThing')?.role).toBe('func');
});

test('json keys vs string values differ, numbers and literals colored', () => {
  const spans = highlightLine('"key": "value", "n": 42, "b": true', 'json');
  expect(spans.some((span) => span.role === 'type' && span.text.includes('"key"'))).toBe(true);
  expect(spans.some((span) => span.role === 'string' && span.text === '"value"')).toBe(true);
  expect(spans.some((span) => span.role === 'number' && span.text === '42')).toBe(true);
  expect(spans.some((span) => span.role === 'keyword' && span.text === 'true')).toBe(true);
});

test('markdown headings and lists are recognized', () => {
  expect(roles('## Title', 'markdown')).toEqual(['keyword']);
  expect(highlightLine('- item', 'markdown')[0]!.role).toBe('operator');
});

test('plain language returns a single text span', () => {
  expect(highlightLine('anything at all', 'plain')).toEqual([{ text: 'anything at all', role: 'text' }]);
});
