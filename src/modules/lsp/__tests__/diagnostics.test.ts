import { test, expect } from 'bun:test';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LanguageClient } from '../LanguageClient';
import { TextDocument } from '../../editor/TextDocument';
import { FakeLspProcess, FakeProvider, flush } from './fakes';

const ROOT = '/tmp/fake-lsp-diag';

function uriFor(path: string): string {
  return pathToFileURL(resolvePath(path)).href;
}

function makeDiagnostic(message: string, line = 0): unknown {
  return {
    range: { start: { line, character: 0 }, end: { line, character: 1 } },
    message,
    severity: 1,
  };
}

test('diagnostics are stored only for the current document revision and stale batches are discarded', async () => {
  const fake = new FakeLspProcess(6001);
  const client = new LanguageClient.Class({
    rootPath: ROOT,
    providers: [new FakeProvider()],
    processFactory: () => fake,
  });
  const path = `${ROOT}/main.ts`;
  const uri = uriFor(path);
  const document = new TextDocument.Class();
  document.loadFromText('const x = 1\n', path);

  try {
    client.openDocument(document);
    await client.whenStarted();
    await fake.waitFor('textDocument/didOpen');
    await flush();

    const current = document.revision.value; // the version stamped onto didOpen

    // A batch older than the current revision is discarded, never applied.
    fake.pushDiagnostics(uri, current - 1, [makeDiagnostic('stale a'), makeDiagnostic('stale b'), makeDiagnostic('stale c')]);
    await flush();
    expect(client.diagnosticCountFor(uri)).toBe(0);

    // A batch naming the exact current revision is accepted.
    fake.pushDiagnostics(uri, current, [makeDiagnostic('real 1'), makeDiagnostic('real 2')]);
    await flush();
    expect(client.diagnosticCountFor(uri)).toBe(2);
    expect(client.diagnosticSlice(uri, 0, 10).map((diagnostic) => diagnostic.message)).toEqual(['real 1', 'real 2']);
    expect(client.diagnosticSlice(uri, 0, 10).every((diagnostic) => diagnostic.version === current)).toBe(true);

    // Edit the document: it advances past `current`. A late batch computed against the old
    // revision must not overwrite the accepted one.
    document.insertInline(0, 0, 'y');
    expect(document.revision.value).toBeGreaterThan(current);
    fake.pushDiagnostics(uri, current, [makeDiagnostic('z1'), makeDiagnostic('z2'), makeDiagnostic('z3'), makeDiagnostic('z4'), makeDiagnostic('z5')]);
    await flush();
    expect(client.diagnosticCountFor(uri)).toBe(2); // unchanged — the stale batch was dropped
  } finally {
    await client.dispose();
  }
});

test('diagnostic storage is capped at maxDiagnosticsPerDocument', async () => {
  const fake = new FakeLspProcess(6003);
  const client = new LanguageClient.Class({
    rootPath: ROOT,
    providers: [new FakeProvider()],
    processFactory: () => fake,
    maxDiagnosticsPerDocument: 3,
  });
  const path = `${ROOT}/many.ts`;
  const uri = uriFor(path);
  const document = new TextDocument.Class();
  document.loadFromText('x\n', path);

  try {
    client.openDocument(document);
    await client.whenStarted();
    await fake.waitFor('textDocument/didOpen');
    await flush();

    const many = Array.from({ length: 10 }, (_, index) => makeDiagnostic(`d${index}`));
    fake.pushDiagnostics(uri, document.revision.value, many);
    await flush();
    expect(client.diagnosticCountFor(uri)).toBe(3); // bounded, not 10
  } finally {
    await client.dispose();
  }
});

test('closing a document clears its diagnostics', async () => {
  const fake = new FakeLspProcess(6002);
  const client = new LanguageClient.Class({
    rootPath: ROOT,
    providers: [new FakeProvider()],
    processFactory: () => fake,
  });
  const path = `${ROOT}/two.ts`;
  const uri = uriFor(path);
  const document = new TextDocument.Class();
  document.loadFromText('let a = 2\n', path);

  try {
    client.openDocument(document);
    await client.whenStarted();
    await fake.waitFor('textDocument/didOpen');
    await flush();

    fake.pushDiagnostics(uri, document.revision.value, [makeDiagnostic('one')]);
    await flush();
    expect(client.diagnosticCountFor(uri)).toBe(1);

    client.closeDocument(document);
    expect(client.diagnosticCountFor(uri)).toBe(0);
  } finally {
    await client.dispose();
  }
});
