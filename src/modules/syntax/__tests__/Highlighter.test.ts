import { test, expect } from 'bun:test';
import { Highlighter } from '../Highlighter';
import { LanguageRegistry } from '../LanguageRegistry';

const roles = (line: string, language: any) => Highlighter.Class.highlightLine(line, language).map((span) => span.role);
const textOf = (line: string, language: any) => Highlighter.Class.highlightLine(line, language).map((span) => span.text).join('');

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
  const spans = Highlighter.Class.highlightLine("const s = 'hi'; // c", 'typescript');
  const byText = (text: string) => spans.find((span) => span.text === text)?.role;
  expect(byText('const')).toBe('keyword');
  expect(spans.find((span) => span.role === 'string')?.text).toBe("'hi'");
  expect(spans.some((span) => span.role === 'comment' && span.text.includes('// c'))).toBe(true);
});

test('PascalCase identifiers are typed, call sites are funcs', () => {
  const spans = Highlighter.Class.highlightLine('new Widget(); doThing()', 'typescript');
  expect(spans.find((span) => span.text === 'Widget')?.role).toBe('type');
  expect(spans.find((span) => span.text === 'doThing')?.role).toBe('func');
});

test('json keys vs string values differ, numbers and literals colored', () => {
  const spans = Highlighter.Class.highlightLine('"key": "value", "n": 42, "b": true', 'json');
  expect(spans.some((span) => span.role === 'type' && span.text.includes('"key"'))).toBe(true);
  expect(spans.some((span) => span.role === 'string' && span.text === '"value"')).toBe(true);
  expect(spans.some((span) => span.role === 'number' && span.text === '42')).toBe(true);
  expect(spans.some((span) => span.role === 'keyword' && span.text === 'true')).toBe(true);
});

test('markdown headings and lists are recognized', () => {
  expect(roles('## Title', 'markdown')).toEqual(['keyword']);
  expect(Highlighter.Class.highlightLine('- item', 'markdown')[0]!.role).toBe('operator');
});

test('plain language returns a single text span', () => {
  expect(Highlighter.Class.highlightLine('anything at all', 'plain')).toEqual([{ text: 'anything at all', role: 'text' }]);
});

test('language registry maps web extensions (html/css/vue + aliases)', () => {
  expect(LanguageRegistry.Class.forPath('index.html')).toBe('html');
  expect(LanguageRegistry.Class.forPath('a.HTM')).toBe('html');
  expect(LanguageRegistry.Class.forPath('icon.svg')).toBe('html');
  expect(LanguageRegistry.Class.forPath('main.css')).toBe('css');
  expect(LanguageRegistry.Class.forPath('theme.scss')).toBe('css');
  expect(LanguageRegistry.Class.forPath('App.vue')).toBe('vue');
});

test('html: tags are keywords, attribute values strings, comments/entities colored — lossless', () => {
  const line = '<a href="x.html" class="c">Hi&amp;</a><!-- note';
  expect(textOf(line, 'html')).toBe(line); // lossless
  const spans = Highlighter.Class.highlightLine(line, 'html');
  expect(spans.find((span) => span.text === 'a')?.role).toBe('keyword');
  expect(spans.find((span) => span.text === 'href')?.role).toBe('variable');
  expect(spans.some((span) => span.role === 'string' && span.text === '"x.html"')).toBe(true);
  expect(spans.some((span) => span.role === 'type' && span.text === '&amp;')).toBe(true);
  expect(spans.some((span) => span.role === 'comment' && span.text.includes('<!-- note'))).toBe(true);
});

test('vue: directives pop as keywords and interpolation is highlighted — lossless', () => {
  const line = '<button v-if="ok" :class="c" @click="go">{{ label }}</button>';
  expect(textOf(line, 'vue')).toBe(line); // lossless
  const spans = Highlighter.Class.highlightLine(line, 'vue');
  expect(spans.find((span) => span.text === 'v-if')?.role).toBe('keyword');
  expect(spans.find((span) => span.text === ':class')?.role).toBe('keyword');
  expect(spans.find((span) => span.text === '@click')?.role).toBe('keyword');
  expect(spans.some((span) => span.role === 'variable' && span.text.includes('label'))).toBe(true);
  // Plain HTML (vue off) does NOT treat v-if as a directive keyword.
  const htmlSpans = Highlighter.Class.highlightLine(line, 'html');
  expect(htmlSpans.find((span) => span.text === 'v-if')?.role).toBe('variable');
});

test('css: selectors, properties, colors, units, at-rules, strings — lossless', () => {
  const line = '.btn { color: #ff0; width: 12px; content: "x"; } /* c */';
  expect(textOf(line, 'css')).toBe(line); // lossless
  const spans = Highlighter.Class.highlightLine(line, 'css');
  expect(spans.find((span) => span.text === '.btn')?.role).toBe('type');
  expect(spans.find((span) => span.text === 'color')?.role).toBe('keyword'); // property (before ':')
  expect(spans.some((span) => span.role === 'number' && span.text === '#ff0')).toBe(true); // hex color
  expect(spans.some((span) => span.role === 'number' && span.text === '12px')).toBe(true); // unit
  expect(spans.some((span) => span.role === 'string' && span.text === '"x"')).toBe(true);
  expect(spans.some((span) => span.role === 'comment' && span.text.includes('/* c */'))).toBe(true);
  expect(Highlighter.Class.highlightLine('@media screen {', 'css').find((span) => span.text === '@media')?.role).toBe('keyword');
});
