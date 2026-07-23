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

test('a versionless batch (real typescript-language-server 5.x) is accepted for the synced revision and dropped after an edit', async () => {
  const fake = new FakeLspProcess(6004);
  const client = new LanguageClient.Class({
    rootPath: ROOT,
    providers: [new FakeProvider()],
    processFactory: () => fake,
  });
  const path = `${ROOT}/versionless.ts`;
  const uri = uriFor(path);
  const document = new TextDocument.Class();
  document.loadFromText('const x = 1\n', path);

  try {
    client.openDocument(document);
    await client.whenStarted();
    await fake.waitFor('textDocument/didOpen');
    await flush();

    // Real servers omit `version` even when versionSupport is advertised; the batch is
    // attributed to the last synced revision and accepted while that is still current.
    fake.pushNotification('textDocument/publishDiagnostics', {
      uri,
      diagnostics: [makeDiagnostic('versionless real')],
    });
    await flush();
    expect(client.diagnosticCountFor(uri)).toBe(1);
    expect(client.diagnosticSlice(uri, 0, 1)[0]?.version).toBe(document.revision.value);

    // After an un-synced edit the synced revision is stale, so a versionless batch is dropped.
    const synced = document.revision.value;
    document.insertInline(0, 0, 'y');
    expect(document.revision.value).toBeGreaterThan(synced);
    fake.pushNotification('textDocument/publishDiagnostics', {
      uri,
      diagnostics: [makeDiagnostic('computed against stale text'), makeDiagnostic('extra')],
    });
    await flush();
    expect(client.diagnosticCountFor(uri)).toBe(1); // unchanged
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

/** Wait long enough for a debounced pull timer (open ~50ms, change ~350ms) to fire, then settle. */
async function waitReal(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  await flush();
}

test('pull-model server (tsgo): diagnostics are pulled via textDocument/diagnostic and stored', async () => {
  const fake = new FakeLspProcess(6101);
  fake.onInitialize = () => ({ capabilities: { diagnosticProvider: { identifier: 'typescript' } } });
  let report: unknown = { kind: 'full', items: [makeDiagnostic('pulled 1'), makeDiagnostic('pulled 2')] };
  fake.responders.set('textDocument/diagnostic', () => report);
  const client = new LanguageClient.Class({
    rootPath: ROOT,
    providers: [new FakeProvider()],
    processFactory: () => fake,
  });
  const path = `${ROOT}/pull.ts`;
  const uri = uriFor(path);
  const document = new TextDocument.Class();
  document.loadFromText('const value: number = "x"\n', path);

  try {
    client.openDocument(document);
    await client.whenStarted();
    await fake.waitFor('textDocument/didOpen');
    // The server never pushed; the client must PULL after the open-debounce window.
    await fake.waitFor('textDocument/diagnostic');
    await waitReal(80);
    expect(client.diagnosticCountFor(uri)).toBe(2);
    expect(client.diagnosticSlice(uri, 0, 10).map((d) => d.message)).toEqual(['pulled 1', 'pulled 2']);

    // A fresh full report that no longer lists the errors REPLACES the batch (clears stale).
    report = { kind: 'full', items: [] };
    document.insertInline(0, 0, 'y');
    client.syncDocument(document);
    await waitReal(450);
    expect(client.diagnosticCountFor(uri)).toBe(0);
  } finally {
    await client.dispose();
  }
});

test('pull-model server: an unchanged report keeps the prior batch and echoes previousResultId', async () => {
  const fake = new FakeLspProcess(6102);
  fake.onInitialize = () => ({ capabilities: { diagnosticProvider: {} } });
  const seenPreviousResultIds: Array<unknown> = [];
  let report: unknown = { kind: 'full', resultId: 'r1', items: [makeDiagnostic('first')] };
  fake.responders.set('textDocument/diagnostic', (params) => {
    seenPreviousResultIds.push((params as { previousResultId?: unknown })?.previousResultId);
    return report;
  });
  const client = new LanguageClient.Class({
    rootPath: ROOT,
    providers: [new FakeProvider()],
    processFactory: () => fake,
  });
  const path = `${ROOT}/unchanged.ts`;
  const uri = uriFor(path);
  const document = new TextDocument.Class();
  document.loadFromText('let a = 1\n', path);

  try {
    client.openDocument(document);
    await client.whenStarted();
    await fake.waitFor('textDocument/diagnostic');
    await waitReal(80);
    expect(client.diagnosticCountFor(uri)).toBe(1);
    expect(seenPreviousResultIds[0]).toBeUndefined(); // no prior resultId on the first pull

    // Next pull returns `unchanged`: prior diagnostics are kept, and the stored resultId is sent back.
    report = { kind: 'unchanged', resultId: 'r2' };
    document.insertInline(0, 0, 'y');
    client.syncDocument(document);
    await waitReal(450);
    expect(client.diagnosticCountFor(uri)).toBe(1); // kept, not cleared
    expect(seenPreviousResultIds[1]).toBe('r1'); // echoed the last resultId
  } finally {
    await client.dispose();
  }
});

test('push-model server (typescript-language-server): the client never sends textDocument/diagnostic', async () => {
  const fake = new FakeLspProcess(6103);
  fake.onInitialize = () => ({ capabilities: {} }); // no diagnosticProvider → push-only
  const client = new LanguageClient.Class({
    rootPath: ROOT,
    providers: [new FakeProvider()],
    processFactory: () => fake,
  });
  const path = `${ROOT}/push.ts`;
  const uri = uriFor(path);
  const document = new TextDocument.Class();
  document.loadFromText('const x = 1\n', path);

  try {
    client.openDocument(document);
    await client.whenStarted();
    await fake.waitFor('textDocument/didOpen');
    await waitReal(120); // well past the open-debounce window

    const sentDiagnosticPull = fake.received.some(
      (message) => 'method' in message && message.method === 'textDocument/diagnostic',
    );
    expect(sentDiagnosticPull).toBe(false);

    // The push path still populates the same store.
    fake.pushDiagnostics(uri, document.revision.value, [makeDiagnostic('pushed')]);
    await flush();
    expect(client.diagnosticCountFor(uri)).toBe(1);
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
