// The markdown → speech transform: strip syntax, announce code blocks, simplify paths so piper reads
// prose instead of spelling out punctuation (the "bebebe" babble).
import { test, expect } from 'bun:test';
import { SpeakableText } from './SpeakableText';

const speak = (markdown: string) => SpeakableText.Class.forSpeech(markdown);

test('a fenced code block becomes a spoken placeholder, not the source', () => {
  expect(speak('Here is the fix:\n```ts\nconst x = 1;\n```\nDone.')).toBe('Here is the fix: code block Done.');
});

test('inline code: a code expression → "code"; a path → last segment (extension dropped)', () => {
  expect(speak('call `render()` again')).toBe('call code again'); // an expression is unspeakable → "code"
  expect(speak('edit `/tmp/wt-voice/src/main.ts`')).toBe('edit main'); // path → last segment, ext dropped
});

test('inline code: a plain identifier is spoken as split words, extension dropped', () => {
  expect(speak('the `hasDocument` getter')).toBe('the has Document getter');
  expect(speak('call `attachWordWrap` here')).toBe('call attach Word Wrap here');
  expect(speak('open `Editor.ts` now')).toBe('open Editor now');
  expect(speak('the `parseHTML` step')).toBe('the parse HTML step');
});

test('a bare absolute path in prose is read as its last segment (no slash-spelling)', () => {
  expect(speak('I committed to /tmp/wt-voice and pushed')).toBe('I committed to wt-voice and pushed');
});

test('a single-slash word like and/or is NOT treated as a path', () => {
  expect(speak('pick one and/or the other')).toBe('pick one and/or the other');
});

test('headings, bullets, and blockquotes drop their leading markers', () => {
  expect(speak('# Summary\n- first\n- second\n> a note')).toBe('Summary first second a note');
});

test('emphasis wrappers are removed', () => {
  expect(speak('this is **bold** and *italic* and __also__ and _more_')).toBe('this is bold and italic and also and more');
});

test('a link is read as its visible text', () => {
  expect(speak('see [the docs](https://example.com/a/b/c) for details')).toBe('see the docs for details');
});

test('plain prose passes through unchanged (whitespace normalized)', () => {
  expect(speak('The quick brown fox.')).toBe('The quick brown fox.');
  expect(speak('  spaced\n\nout   text  ')).toBe('spaced out text');
});

test('the first reported babble case reads cleanly (paths + filenames)', () => {
  const input = 'I ran `/tmp/wt-voice/scripts/merge-gate.sh` and it passed. See `SpeakableText.ts`.';
  expect(speak(input)).toBe('I ran merge-gate and it passed. See Speakable Text.');
});

test('the SECOND reported babble case (dense inline code) is fully speakable — no stray symbols', () => {
  // The exact snippet the user reported garbled. Every code span must read as words or "code".
  const input =
    'The ivue pattern is disciplined everywhere I looked. `Editor.ts` defines ' +
    '`get hasDocument() { return ref(false) }`, and `createX()` plus `attachWordWrap` follow suit.';
  const out = speak(input);
  expect(out).toBe(
    'The ivue pattern is disciplined everywhere I looked. Editor defines code, and code plus attach Word Wrap follow suit.',
  );
  // Hard guarantees: no unspeakable symbols and no bare ".ts" survive.
  expect(out).not.toMatch(/[(){}[\];=]/);
  expect(out).not.toContain('.ts');
});

test('bare (un-backticked) prose: paths + filenames + multi-word identifiers, but brand words spared', () => {
  expect(speak('committed to /tmp/wt-voice/Editor.ts today')).toBe('committed to Editor today');
  expect(speak('the attachWordWrap helper')).toBe('the attach Word Wrap helper'); // 2 humps → split
  expect(speak('built with GitHub and JavaScript on iPhone')).toBe('built with GitHub and JavaScript on iPhone'); // 1 hump each → spared
});

test('empty / whitespace-only input yields empty string', () => {
  expect(speak('')).toBe('');
  expect(speak('   \n  ')).toBe('');
});
