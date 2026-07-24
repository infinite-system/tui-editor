import { describe, expect, test } from 'bun:test';
import { EditorCoordinates } from '../EditorCoordinates';
import { TextEditing } from '../TextEditing';

function deleteAtEnd(text: string) {
  return TextEditing.Class.deletePreviousWord(text, EditorCoordinates.Class.graphemeCount(text));
}

describe('delete previous word', () => {
  test('mid-word deletion removes the prefix back to the word boundary', () => {
    expect(TextEditing.Class.deletePreviousWord('hello', 3)).toEqual({
      text: 'lo',
      start: 0,
      end: 3,
    });
  });

  test('a boundary skips trailing whitespace then removes the preceding word run', () => {
    expect(deleteAtEnd('hello world').text).toBe('hello ');
    expect(deleteAtEnd('hello ').text).toBe('');
  });

  test('leading whitespace is one deletable run when no word precedes it', () => {
    expect(TextEditing.Class.deletePreviousWord('    hello', 4)).toEqual({
      text: 'hello',
      start: 0,
      end: 4,
    });
  });

  test('punctuation and word runs have distinct boundaries', () => {
    const punctuationDeleted = deleteAtEnd('hello...');
    expect(punctuationDeleted.text).toBe('hello');
    expect(deleteAtEnd(punctuationDeleted.text).text).toBe('');
  });

  test('line start deletes only the newline and joins the lines', () => {
    expect(TextEditing.Class.deletePreviousWord('hello\nworld', 6)).toEqual({
      text: 'helloworld',
      start: 5,
      end: 6,
    });
  });

  test('boundaries and deletion stay grapheme-safe', () => {
    expect(deleteAtEnd('go 😀😀').text).toBe('go ');
    expect(TextEditing.Class.deletePreviousWord('e\u0301lan', 1).text).toBe('lan');
  });
});

describe('wordRight (mirror of wordLeft)', () => {
  const wordRight = (text: string, cursor: number) => TextEditing.Class.wordRight(text, cursor);

  test('from a word, jumps to the START of the next word (crossing trailing whitespace)', () => {
    expect(wordRight('alpha beta gamma', 0)).toBe(6); // start of "beta"
    expect(wordRight('alpha beta gamma', 6)).toBe(11); // start of "gamma"
  });

  test('from mid-word, finishes the current word then skips to the next', () => {
    expect(wordRight('alpha beta', 2)).toBe(6); // "lpha" then space → start of "beta"
  });

  test('clamps at the end of the text', () => {
    expect(wordRight('alpha', 5)).toBe(5);
    expect(wordRight('alpha', 99)).toBe(5);
  });

  test('crosses a punctuation run as its own word', () => {
    expect(wordRight('a, b', 0)).toBe(1); // "a" → before the comma
    expect(wordRight('a, b', 1)).toBe(3); // "," (+ space) → before "b"
  });
});
