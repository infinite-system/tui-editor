import { test, expect } from 'bun:test';
import { LanguageClient } from '../LanguageClient';
import { TextDocument } from '../../editor/TextDocument';
import { FakeLspProcess, FakeProvider, flush } from './fakes';

const ROOT = '/tmp/fake-lsp-coord';

// '😀' is one grapheme but two UTF-16 code units. Grapheme column 1 (just past the emoji)
// must cross the client API as UTF-16 character 2, and a server range in UTF-16 must map
// back to grapheme columns.
test('client positions cross to the server as UTF-16 and server ranges map back to graphemes', async () => {
  const fake = new FakeLspProcess(7001);
  fake.responders.set('textDocument/hover', () => ({
    contents: 'x',
    range: { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } },
  }));
  const client = new LanguageClient.Class({
    rootPath: ROOT,
    providers: [new FakeProvider()],
    processFactory: () => fake,
  });
  const document = new TextDocument.Class();
  document.loadFromText('😀ab\n', `${ROOT}/emoji.ts`);

  try {
    const hover = await client.hover(document, { line: 0, column: 1 });
    await flush();

    const request = fake.received.find(
      (message) => 'method' in message && message.method === 'textDocument/hover',
    ) as { params: { position: { character: number } } } | undefined;
    // Grapheme column 1 -> UTF-16 character 2 (past the surrogate pair), not 1.
    expect(request?.params.position.character).toBe(2);

    // Server range in UTF-16 (2..4) maps back to grapheme columns (1..3).
    expect(hover?.range?.start.column).toBe(1);
    expect(hover?.range?.end.column).toBe(3);
  } finally {
    await client.dispose();
  }
});
