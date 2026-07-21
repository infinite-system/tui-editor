import { test, expect } from 'bun:test';
import { MarkdownParser, InlineStyle, type BlockRecord } from '../MarkdownParser';

const parse = (source: string, revision = 0): readonly BlockRecord[] =>
  new MarkdownParser.Class().parse(source, revision).blocks;

const kinds = (source: string) => parse(source).map((block) => block.kind);

test('parses a heading with level', () => {
  const [atx] = parse('## Title here');
  expect(atx!.kind).toBe('heading');
  expect(atx!.level).toBe(2);
  expect(atx!.text).toBe('Title here');

  // setext underline form
  const setext = parse('Big Title\n=========');
  expect(setext[0]!.kind).toBe('heading');
  expect(setext[0]!.level).toBe(1);
  expect(setext[0]!.text).toBe('Big Title');
});

test('parses a paragraph as a single joined block', () => {
  const blocks = parse('one line\ntwo line\nthree');
  expect(blocks).toHaveLength(1);
  expect(blocks[0]!.kind).toBe('paragraph');
  expect(blocks[0]!.text).toBe('one line two line three');
});

test('parses ordered and unordered list items with markers', () => {
  const bullets = parse('- first\n- second\n  - nested');
  // a container 'list' block plus one 'listitem' per row
  expect(bullets[0]!.kind).toBe('list');
  const items = bullets.filter((block) => block.kind === 'listitem');
  expect(items.map((item) => item.text)).toEqual(['first', 'second', 'nested']);
  expect(items[0]!.marker).toBe('•');
  expect(items[2]!.level).toBe(2); // two-space indent → depth 2

  const ordered = parse('1. one\n2. two').filter((block) => block.kind === 'listitem');
  expect(ordered.map((item) => item.marker)).toEqual(['1.', '2.']);
});

test('parses a fenced code block with language', () => {
  const [code] = parse('```ts\nconst x = 1;\nconst y = 2;\n```');
  expect(code!.kind).toBe('code');
  expect(code!.language).toBe('ts');
  expect(code!.text).toBe('const x = 1;\nconst y = 2;');
  // code content is verbatim: no inline spans harvested
  expect(code!.spans).toHaveLength(0);
});

test('parses a blockquote joining stripped lines', () => {
  const [quote] = parse('> quoted line\n> second quote');
  expect(quote!.kind).toBe('blockquote');
  expect(quote!.text).toBe('quoted line\nsecond quote');
});

test('parses a table into normalized rows', () => {
  const [table] = parse('| a | b |\n| --- | --- |\n| 1 | 2 |');
  expect(table!.kind).toBe('table');
  // header + body rows, separator row dropped, cells joined with a box divider
  expect(table!.text).toBe('a │ b\n1 │ 2');
});

test('parses a horizontal rule', () => {
  expect(kinds('---')).toEqual(['hr']);
});

test('packs inline emphasis strong code and link into flat spans', () => {
  const [paragraph] = parse('A **bold**, *em*, `code` and a [link](https://x.y).');
  expect(paragraph!.kind).toBe('paragraph');
  // markup is stripped from the rendered text
  expect(paragraph!.text).toBe('A bold, em, code and a link.');
  // spans are packed 4 ints per run: [start, end, style, linkIndexPlusOne] — never token objects
  expect(paragraph!.spans.length % 4).toBe(0);
  const runs = [];
  for (let spanIndex = 0; spanIndex < paragraph!.spans.length; spanIndex += 4) {
    runs.push({
      text: paragraph!.text.slice(paragraph!.spans[spanIndex]!, paragraph!.spans[spanIndex + 1]!),
      style: paragraph!.spans[spanIndex + 2]!,
      link: paragraph!.spans[spanIndex + 3]!,
    });
  }
  expect(runs).toEqual([
    { text: 'bold', style: InlineStyle.Strong, link: 0 },
    { text: 'em', style: InlineStyle.Emphasis, link: 0 },
    { text: 'code', style: InlineStyle.Code, link: 0 },
    { text: 'link', style: InlineStyle.Link, link: 1 },
  ]);
  expect(paragraph!.links).toEqual(['https://x.y']);
});

test('a block record is a plain object with no reactive members', () => {
  const paragraph = parse('plain text')[0]!;
  // every own value is a primitive, a plain array, or a plain range object — no Ref (.value getter)
  const record = paragraph as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (value && typeof value === 'object') {
      expect('value' in (value as object)).toBe(false); // not a Vue Ref
    }
  }
});

test('stamps block source ranges and preserves the revision', () => {
  const result = new MarkdownParser.Class().parse('# H\n\npara', 42);
  expect(result.revision).toBe(42);
  const [heading, paragraph] = result.blocks;
  expect(heading!.range.startLine).toBe(0);
  expect(heading!.range.startOffset).toBe(0);
  // paragraph begins after '# H\n\n' → offset 5, line 2
  expect(paragraph!.range.startLine).toBe(2);
  expect(paragraph!.range.startOffset).toBe(5);
});
