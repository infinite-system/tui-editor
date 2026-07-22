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
