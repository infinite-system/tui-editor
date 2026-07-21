import { describe, expect, test } from 'bun:test';
import { TextDocument } from '../editor/TextDocument';
import { FindInBuffer } from './FindInBuffer';

function createFindInBuffer(text: string): {
  document: TextDocument.Instance;
  findInBuffer: FindInBuffer.Instance;
} {
  const document = new TextDocument.Class();
  document.loadFromText(text);
  return {
    document,
    findInBuffer: new FindInBuffer.Class(document),
  };
}

describe('FindInBuffer matching', () => {
  test('literal, regular expression, case-sensitive, and whole-word modes count independently', () => {
    const { findInBuffer } = createFindInBuffer('Foo foo foobar\nFOO food foo');

    findInBuffer.query.value = 'foo';
    expect(findInBuffer.findAll()).toHaveLength(6);

    findInBuffer.useRegex.value = true;
    findInBuffer.query.value = 'f.o';
    expect(findInBuffer.findAll()).toHaveLength(6);

    findInBuffer.useRegex.value = false;
    findInBuffer.caseSensitive.value = true;
    findInBuffer.query.value = 'foo';
    expect(findInBuffer.findAll()).toHaveLength(4);

    findInBuffer.caseSensitive.value = false;
    findInBuffer.wholeWord.value = true;
    expect(findInBuffer.findAll()).toHaveLength(4);
  });

  test('literal mode escapes regular-expression punctuation and reports grapheme columns', () => {
    const { findInBuffer } = createFindInBuffer('😀 a.b aXb');
    findInBuffer.query.value = 'a.b';

    expect(findInBuffer.findAll()).toEqual([
      { line: 0, startColumn: 2, endColumn: 5 },
    ]);
  });

  test('an empty query or invalid regular expression produces no matches', () => {
    const { findInBuffer } = createFindInBuffer('anything');
    expect(findInBuffer.findAll()).toEqual([]);

    findInBuffer.useRegex.value = true;
    findInBuffer.query.value = '[';
    expect(findInBuffer.findAll()).toEqual([]);
    expect(findInBuffer.currentMatchIndex.value).toBe(-1);
  });
});

describe('FindInBuffer navigation', () => {
  test('next and previous wrap at both ends and expose the current range', () => {
    const { findInBuffer } = createFindInBuffer('one one\none');
    findInBuffer.query.value = 'one';
    findInBuffer.findAll();

    expect(findInBuffer.currentMatch).toEqual({ line: 0, startColumn: 0, endColumn: 3 });
    expect(findInBuffer.currentMatchRange).toEqual(findInBuffer.currentMatch);
    expect(findInBuffer.previous()).toEqual({ line: 1, startColumn: 0, endColumn: 3 });
    expect(findInBuffer.next()).toEqual({ line: 0, startColumn: 0, endColumn: 3 });
    findInBuffer.next();
    findInBuffer.next();
    expect(findInBuffer.next()).toEqual({ line: 0, startColumn: 0, endColumn: 3 });
  });
});

describe('FindInBuffer replacement', () => {
  test('replaceCurrent changes only the selected occurrence and recomputes matches', () => {
    const { document, findInBuffer } = createFindInBuffer('red red red');
    findInBuffer.query.value = 'red';
    findInBuffer.replacement.value = 'blue';
    findInBuffer.findAll();
    findInBuffer.next();

    expect(findInBuffer.replaceCurrent()).toBe(true);
    expect(document.text).toBe('red blue red');
    expect(findInBuffer.matchCount).toBe(2);
    expect(findInBuffer.matches.value).toEqual([
      { line: 0, startColumn: 0, endColumn: 3 },
      { line: 0, startColumn: 9, endColumn: 12 },
    ]);
  });

  test('replaceAll applies every change through one document batch and updates matches', () => {
    const { document, findInBuffer } = createFindInBuffer('cat cat\ncat');
    findInBuffer.query.value = 'cat';
    findInBuffer.replacement.value = 'dog';
    const revisionBeforeReplacement = document.revision.value;

    expect(findInBuffer.replaceAll()).toBe(3);
    expect(document.text).toBe('dog dog\ndog');
    expect(document.revision.value).toBe(revisionBeforeReplacement + 1);
    expect(findInBuffer.matchCount).toBe(0);
    expect(findInBuffer.currentMatch).toBeNull();
  });

  test('regular-expression capture groups expand in replaceCurrent and replaceAll', () => {
    const { document, findInBuffer } = createFindInBuffer('left=12 right=7');
    findInBuffer.useRegex.value = true;
    findInBuffer.query.value = '([a-z]+)=(\\d+)';
    findInBuffer.replacement.value = '$1:[$2]';
    findInBuffer.findAll();

    expect(findInBuffer.replaceCurrent()).toBe(true);
    expect(document.text).toBe('left:[12] right=7');
    expect(findInBuffer.matchCount).toBe(1);

    expect(findInBuffer.replaceAll()).toBe(1);
    expect(document.text).toBe('left:[12] right:[7]');
    expect(findInBuffer.matchCount).toBe(0);
  });
});
