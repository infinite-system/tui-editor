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

function diag(message: string, line = 0): unknown {
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
  const doc = new TextDocument.Class();
  doc.loadFromText('const x = 1\n', path);

  try {
    client.openDocument(doc);
    await client.whenStarted();
    await fake.waitFor('textDocument/didOpen');
    await flush();

    const current = doc.revision.value; // the version stamped onto didOpen

    // A batch older than the current revision is discarded, never applied.
    fake.pushDiagnostics(uri, current - 1, [diag('stale a'), diag('stale b'), diag('stale c')]);
    await flush();
    expect(client.diagnosticCountFor(uri)).toBe(0);

    // A batch naming the exact current revision is accepted.
    fake.pushDiagnostics(uri, current, [diag('real 1'), diag('real 2')]);
    await flush();
    expect(client.diagnosticCountFor(uri)).toBe(2);
    expect(client.diagnosticSlice(uri, 0, 10).map((d) => d.message)).toEqual(['real 1', 'real 2']);
    expect(client.diagnosticSlice(uri, 0, 10).every((d) => d.version === current)).toBe(true);

    // Edit the document: it advances past `current`. A late batch computed against the old
    // revision must not overwrite the accepted one.
    doc.insertInline(0, 0, 'y');
    expect(doc.revision.value).toBeGreaterThan(current);
    fake.pushDiagnostics(uri, current, [diag('z1'), diag('z2'), diag('z3'), diag('z4'), diag('z5')]);
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
  const doc = new TextDocument.Class();
  doc.loadFromText('x\n', path);

  try {
    client.openDocument(doc);
    await client.whenStarted();
    await fake.waitFor('textDocument/didOpen');
    await flush();

    const many = Array.from({ length: 10 }, (_, i) => diag(`d${i}`));
    fake.pushDiagnostics(uri, doc.revision.value, many);
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
  const doc = new TextDocument.Class();
  doc.loadFromText('let a = 2\n', path);

  try {
    client.openDocument(doc);
    await client.whenStarted();
    await fake.waitFor('textDocument/didOpen');
    await flush();

    fake.pushDiagnostics(uri, doc.revision.value, [diag('one')]);
    await flush();
    expect(client.diagnosticCountFor(uri)).toBe(1);

    client.closeDocument(doc);
    expect(client.diagnosticCountFor(uri)).toBe(0);
  } finally {
    await client.dispose();
  }
});
