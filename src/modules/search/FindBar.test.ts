import { expect, test } from 'bun:test';
import { TextDocument } from '../editor/TextDocument';
import { FindBar } from './FindBar';

test('deletePreviousWord edits both find and replace fields through the shared boundary', () => {
  const document = new TextDocument.Class();
  document.loadFromText('foo bar');
  const findBar = new FindBar.Class();
  findBar.openFor(document, 'replace');
  findBar.append('foo bar');
  findBar.deletePreviousWord();
  expect(findBar.engine?.query.value).toBe('foo ');

  findBar.switchField();
  findBar.append('one...');
  findBar.deletePreviousWord();
  expect(findBar.engine?.replacement.value).toBe('one');
});
