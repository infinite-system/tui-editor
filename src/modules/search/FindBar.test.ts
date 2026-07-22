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

// invariant: Markdown panes keep independent find state (src/modules/markdown/markdown.invariants.md)
// invariant: Diff panes keep independent find state (src/modules/diff/diff.invariants.md)
test('pane targets retain independent queries and matches when focus changes', () => {
  const sourceDocument = new TextDocument.Class();
  sourceDocument.loadFromText('source term\nsource term');
  const previewDocument = new TextDocument.Class();
  previewDocument.loadFromText('rendered term');
  const findBar = new FindBar.Class();

  findBar.openForTarget({
    identifier: 'source-pane',
    document: sourceDocument,
    replaceAllowed: true,
    revealMatch: () => {},
  }, 'find');
  findBar.append('source');
  expect(findBar.engine?.matchCount).toBe(2);

  findBar.openForTarget({
    identifier: 'preview-pane',
    document: previewDocument,
    replaceAllowed: false,
    revealMatch: () => {},
  }, 'replace');
  findBar.append('rendered');
  expect(findBar.mode.value).toBe('find');
  expect(findBar.engine?.matchCount).toBe(1);

  expect(findBar.engineFor('source-pane')?.query.value).toBe('source');
  expect(findBar.engineFor('source-pane')?.matchCount).toBe(2);
  expect(findBar.engineFor('preview-pane')?.query.value).toBe('rendered');
  expect(findBar.engineFor('preview-pane')?.matchCount).toBe(1);
});
