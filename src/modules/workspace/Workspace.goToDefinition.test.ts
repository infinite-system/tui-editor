// Go-to-definition wiring at the Workspace layer: opening a buffer registers it with the
// per-workspace LanguageClient (didOpen), edits sync (didChange), closing releases (didClose),
// and goToDefinition() jumps — opens the target file as a tab and lands the cursor on the
// declaration, including the import-specifier re-hop the real server exhibits. Runs the REAL
// LanguageClient + LspTransport over the in-process FakeLspProcess (no binary spawned).
//
// invariant: A definition gesture jumps to the declaration (src/modules/lsp/lsp.invariants.md)
import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { Reactive } from 'ivue';
import { Workspace } from './Workspace';
import { LanguageClient } from '../lsp/LanguageClient';
import { FakeLspProcess, FakeProvider, flush } from '../lsp/__tests__/fakes';
import {
  mkdtempSync as makeTemporaryDirectorySync,
  rmSync as removeSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir as temporaryDirectory } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

class $GoToDefinitionWorkspace extends Workspace.$Class {
  readonly fakeLanguageServerProcess = new FakeLspProcess();

  protected override createLanguageClient() {
    return new LanguageClient.Class({
      rootPath: this.root,
      providers: [new FakeProvider()],
      processFactory: () => this.fakeLanguageServerProcess,
    });
  }
}
const GoToDefinitionWorkspace = Reactive($GoToDefinitionWorkspace);

let workspaceDirectory = '';
let declarationPath = '';
let usagePath = '';

const DECLARATION_RANGE = {
  start: { line: 0, character: 16 },
  end: { line: 0, character: 27 },
};
const IMPORT_SPECIFIER_RANGE = {
  start: { line: 0, character: 9 },
  end: { line: 0, character: 20 },
};

beforeEach(() => {
  workspaceDirectory = makeTemporaryDirectorySync(join(temporaryDirectory(), 'tui-gotodef-'));
  declarationPath = join(workspaceDirectory, 'foo.ts');
  usagePath = join(workspaceDirectory, 'bar.ts');
  writeFileSync(
    declarationPath,
    'export function greetWidget(name: string): string {\n  return `hello ${name}`;\n}\n',
  );
  writeFileSync(
    usagePath,
    "import { greetWidget } from './foo';\n\nconst message = greetWidget('world');\nexport { message };\n",
  );
});

afterEach(() => {
  removeSync(workspaceDirectory, { recursive: true, force: true });
});

function buildWorkspace(): InstanceType<typeof GoToDefinitionWorkspace> {
  const workspace = new GoToDefinitionWorkspace();
  workspace.root = workspaceDirectory;
  return workspace;
}

describe('Workspace go-to-definition wiring', () => {
  test('opening a supported buffer reaches the server as didOpen; edits sync as didChange; closing sends didClose', async () => {
    const workspace = buildWorkspace();
    workspace.openFileInTab(usagePath);
    await workspace.fakeLanguageServerProcess.waitFor('textDocument/didOpen');
    await flush();

    workspace.editor.insertText('x');
    workspace.syncActiveDocumentWithLanguageServer();
    await workspace.fakeLanguageServerProcess.waitFor('textDocument/didChange');

    workspace.closeTab(0);
    await workspace.fakeLanguageServerProcess.waitFor('textDocument/didClose');
    workspace.dispose();
    await flush();
  });

  test('goToDefinition opens the declaring file as a tab and lands the cursor on the declaration', async () => {
    const workspace = buildWorkspace();
    workspace.fakeLanguageServerProcess.responders.set('textDocument/definition', () => [
      { uri: pathToFileURL(declarationPath).href, range: DECLARATION_RANGE },
    ]);
    workspace.openFileInTab(usagePath);
    await flush();

    const jumped = await workspace.goToDefinition({ line: 2, column: 16 });
    expect(jumped).toBe(true);
    expect(workspace.editor.document.path).toBe(declarationPath);
    expect(workspace.buffers.count).toBe(2);
    expect(workspace.editor.cursor.line.value).toBe(0);
    expect(workspace.editor.cursor.col.value).toBe(16);
    expect(workspace.focus.value).toBe('editor');
    workspace.dispose();
    await flush();
  });

  test('a definition landing on the requesting file\'s import line re-hops once to the declaration', async () => {
    const workspace = buildWorkspace();
    let definitionRequestCount = 0;
    workspace.fakeLanguageServerProcess.responders.set('textDocument/definition', () => {
      definitionRequestCount += 1;
      // First answer: the import specifier inside bar.ts (what the real server returns while
      // foo.ts is not open). Second answer (from the import): the original declaration.
      if (definitionRequestCount === 1) {
        return [{ uri: pathToFileURL(usagePath).href, range: IMPORT_SPECIFIER_RANGE }];
      }
      return [{ uri: pathToFileURL(declarationPath).href, range: DECLARATION_RANGE }];
    });
    workspace.openFileInTab(usagePath);
    await flush();

    const jumped = await workspace.goToDefinition({ line: 2, column: 16 });
    expect(jumped).toBe(true);
    expect(definitionRequestCount).toBe(2);
    expect(workspace.editor.document.path).toBe(declarationPath);
    expect(workspace.editor.cursor.line.value).toBe(0);
    expect(workspace.editor.cursor.col.value).toBe(16);
    workspace.dispose();
    await flush();
  });

  test('goToDefinition resolves false without a jump when the server has no answer or the file is unsupported', async () => {
    const workspace = buildWorkspace();
    workspace.fakeLanguageServerProcess.responders.set('textDocument/definition', () => null);
    workspace.openFileInTab(usagePath);
    await flush();
    expect(await workspace.goToDefinition({ line: 2, column: 16 })).toBe(false);
    expect(workspace.editor.document.path).toBe(usagePath);

    // An unsupported file never reaches the server (and never starts one).
    const plainTextPath = join(workspaceDirectory, 'notes.txt');
    writeFileSync(plainTextPath, 'plain text\n');
    workspace.openFileInTab(plainTextPath);
    expect(await workspace.goToDefinition({ line: 0, column: 0 })).toBe(false);
    expect(workspace.editor.document.path).toBe(plainTextPath);
    workspace.dispose();
    await flush();
  });

  test('workspace dispose releases the language-server subprocess', async () => {
    const workspace = buildWorkspace();
    workspace.openFileInTab(usagePath);
    await workspace.fakeLanguageServerProcess.waitFor('textDocument/didOpen');
    workspace.dispose();
    await flush();
    expect(workspace.fakeLanguageServerProcess.killed).toBe(true);
  });
});
