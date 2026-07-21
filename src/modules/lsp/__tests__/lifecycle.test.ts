import { test, expect } from 'bun:test';
import { LanguageClient } from '../LanguageClient';
import { TextDocument } from '../../editor/TextDocument';
import { StatusChannel } from '../../system/StatusChannel';
import { FakeLspProcess, FakeProvider, flush } from './fakes';

const ROOT = '/tmp/fake-lsp-root';

function makeClient(fake: FakeLspProcess): LanguageClient.Instance {
  return new LanguageClient.Class({
    rootPath: ROOT,
    providers: [new FakeProvider()],
    processFactory: () => fake,
  });
}

function makeDocument(path: string, text = 'const x = 1\n'): TextDocument.Instance {
  const document = new TextDocument.Class();
  document.loadFromText(text, path);
  return document;
}

test('the server is not started until a supported document or semantic feature is requested', async () => {
  const fake = new FakeLspProcess(5001);
  const client = makeClient(fake);
  try {
    // Just constructing the client starts nothing.
    expect(fake.startCalled).toBe(false);
    expect(client.status.value).toBe('idle');

    // Opening an UNSUPPORTED file must not start a server either.
    client.openDocument(makeDocument(`${ROOT}/readme.txt`));
    await flush();
    expect(fake.startCalled).toBe(false);
    expect(client.status.value).toBe('idle');
  } finally {
    await client.dispose();
  }
});

test('opening a supported document lazily starts the server and reaches ready', async () => {
  const fake = new FakeLspProcess(5002);
  const client = makeClient(fake);
  try {
    client.openDocument(makeDocument(`${ROOT}/a.ts`));
    const ready = await client.whenStarted();

    expect(ready).toBe(true);
    expect(fake.startCalled).toBe(true);
    expect(client.status.value).toBe('ready');
    // The server received the initialize handshake and the didOpen sync.
    const methods = fake.received.map((message) => ('method' in message ? message.method : null));
    expect(methods).toContain('initialize');
    expect(methods).toContain('initialized');
    expect(methods).toContain('textDocument/didOpen');
    // The live subprocess pid is published on the status channel.
    expect(StatusChannel.Class.snapshot.subprocessPids).toContain(5002);
  } finally {
    await client.dispose();
  }
});

test('a semantic command with no prior openDocument still starts the server lazily', async () => {
  const fake = new FakeLspProcess(5003);
  fake.responders.set('textDocument/hover', () => ({ contents: 'ok' }));
  const client = makeClient(fake);
  try {
    expect(fake.startCalled).toBe(false);
    const document = makeDocument(`${ROOT}/b.ts`);
    const hover = await client.hover(document, { line: 0, column: 0 });
    expect(fake.startCalled).toBe(true);
    expect(hover?.contents).toBe('ok');
  } finally {
    await client.dispose();
  }
});

test('dispose kills the subprocess, stops the transport, and drops the published pid', async () => {
  const fake = new FakeLspProcess(5004);
  const client = makeClient(fake);
  client.openDocument(makeDocument(`${ROOT}/c.ts`));
  await client.whenStarted();
  expect(fake.running).toBe(true);
  expect(StatusChannel.Class.snapshot.subprocessPids).toContain(5004);

  await client.dispose();

  expect(fake.killed).toBe(true);
  expect(fake.running).toBe(false);
  expect(client.status.value).toBe('disposed');
  const exitCode = await fake.exited; // no orphan — the child has exited
  expect(exitCode).toBe(0);
  expect(StatusChannel.Class.snapshot.subprocessPids).not.toContain(5004);
});

test('a missing server executable degrades to unavailable without throwing', async () => {
  // A provider that resolves nothing models a machine with no language server installed.
  const client = new LanguageClient.Class({
    rootPath: ROOT,
    providers: [
      {
        id: 'none',
        capabilities: { diagnostics: true, definition: true, hover: true, references: true },
        supportsPath: (path: string) => path.endsWith('.ts'),
        resolve: async () => null,
      },
    ],
  });
  try {
    client.openDocument(makeDocument(`${ROOT}/d.ts`));
    const ready = await client.whenStarted();
    expect(ready).toBe(false);
    expect(client.status.value).toBe('unavailable');
    // Semantic requests just return empty — they never throw into the editor.
    expect(await client.hover(makeDocument(`${ROOT}/d.ts`), { line: 0, column: 0 })).toBeNull();
  } finally {
    await client.dispose();
  }
});
