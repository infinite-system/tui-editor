// Driven verification: the REAL LanguageClient against a REAL typescript-language-server
// over stdio — no fakes. Proves initialize handshake, didOpen/didChange sync, definition,
// hover, publishDiagnostics (versionless, as real servers send them), UTF-16 conversion
// through a wide-emoji AND a multi-code-point ZWJ grapheme, and disposal.
//
// Run:  bun scripts/drive-lsp-real-server.ts
// Needs `typescript-language-server` + `typescript` resolvable (repo devDependencies suffice —
// the temp workspace symlinks this repo's node_modules). Exits non-zero on any failure.
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LanguageClient } from '../src/modules/lsp/LanguageClient';
import { TextDocument } from '../src/modules/editor/TextDocument';
import { EditorCoordinates } from '../src/modules/editor/EditorCoordinates';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const workspaceRoot = mkdtempSync(join(tmpdir(), 'invar-lsp-drive-'));
let failures = 0;

function check(label: string, passed: boolean, detail: unknown): void {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}  ${JSON.stringify(detail)}`);
  if (!passed) failures++;
}

symlinkSync(join(repositoryRoot, 'node_modules'), join(workspaceRoot, 'node_modules'));
writeFileSync(
  join(workspaceRoot, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true },
    include: ['*.ts'],
  }),
);
writeFileSync(
  join(workspaceRoot, 'foo.ts'),
  'export function greetWidget(name: string): string {\n  return `hello ${name}`;\n}\n',
);
writeFileSync(
  join(workspaceRoot, 'bar.ts'),
  "import { greetWidget } from './foo';\n\n" +
    "const message = /* 👍 wide */ greetWidget('world');\n" +
    'const broken: number = message;\n' +
    'export { message };\n',
);

const client = new LanguageClient.Class({ rootPath: workspaceRoot });
try {
  const barDocument = new TextDocument.Class();
  barDocument.loadFromFile(join(workspaceRoot, 'bar.ts'));
  const fooDocument = new TextDocument.Class();
  fooDocument.loadFromFile(join(workspaceRoot, 'foo.ts'));
  client.openDocument(barDocument);
  client.openDocument(fooDocument);

  const started = await client.whenStarted();
  check('handshake reaches ready', started && client.status.value === 'ready', {
    status: client.status.value,
    error: client.error.value,
    provider: client.activeProviderId.value,
  });
  if (!started) throw new Error('language server did not start');

  // Definition at the use site AFTER a wide emoji (surrogate pair) on the same line.
  const useLineIndex = 2;
  const useLineText = barDocument.line(useLineIndex);
  const useColumn = EditorCoordinates.Class.u16ToGrapheme(useLineText, useLineText.indexOf('greetWidget'));
  const definitionLocation = await client.definition(barDocument, { line: useLineIndex, column: useColumn });
  check(
    'definition resolves to foo.ts greetWidget declaration',
    definitionLocation !== null &&
      definitionLocation.uri.endsWith('/foo.ts') &&
      definitionLocation.range.start.line === 0 &&
      definitionLocation.range.start.column === 16 &&
      definitionLocation.range.end.column === 27,
    definitionLocation,
  );

  const hoverResult = await client.hover(barDocument, { line: useLineIndex, column: useColumn });
  check(
    'hover names the greetWidget signature',
    hoverResult !== null && hoverResult.contents.includes('greetWidget(name: string): string'),
    hoverResult?.contents.slice(0, 80),
  );

  // Versionless publishDiagnostics from the real server: TS2322 on line 3.
  const waitStart = Date.now();
  while (client.diagnosticCountFor(barDocument) === 0 && Date.now() - waitStart < 20_000) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const diagnostics = client.diagnosticSlice(barDocument, 0, 10);
  check(
    'real (versionless) diagnostics arrive with TS2322 on line 3',
    diagnostics.some((diagnostic) => diagnostic.code === 2322 && diagnostic.range.start.line === 3),
    diagnostics.map((diagnostic) => ({ code: diagnostic.code, line: diagnostic.range.start.line })),
  );

  // didChange path + ZWJ grapheme (multi-code-point) BEFORE the use site: append a line whose
  // use-site grapheme/code-point/UTF-16 columns all differ, then request definition on it.
  const zwjStatement = "const zwjLabel = '👨‍👩‍👧'; export const zwjUse = greetWidget(zwjLabel);";
  barDocument.insertMultiline(barDocument.lineCount - 1, 0, '');
  const zwjLineIndex = barDocument.lineCount - 1;
  barDocument.insertInline(zwjLineIndex, 0, zwjStatement);
  client.syncDocument(barDocument);
  const zwjLineText = barDocument.line(zwjLineIndex);
  const zwjUtf16 = zwjLineText.indexOf('greetWidget');
  const zwjColumn = EditorCoordinates.Class.u16ToGrapheme(zwjLineText, zwjUtf16);
  const zwjDefinition = await client.definition(barDocument, { line: zwjLineIndex, column: zwjColumn });
  // The server resolves either straight to the declaration in foo.ts (16..27) or, when the
  // target file is not open, to the import alias in bar.ts (9..20) — both are the greetWidget
  // identifier, exactly 11 columns wide on line 0.
  const zwjResolved =
    zwjDefinition !== null &&
    zwjDefinition.range.start.line === 0 &&
    ((zwjDefinition.uri.endsWith('/foo.ts') && zwjDefinition.range.start.column === 16 && zwjDefinition.range.end.column === 27) ||
      (zwjDefinition.uri.endsWith('/bar.ts') && zwjDefinition.range.start.column === 9 && zwjDefinition.range.end.column === 20));
  check(
    'post-edit definition through a ZWJ-grapheme line resolves greetWidget',
    zwjResolved,
    { utf16: zwjUtf16, grapheme: zwjColumn, codePoints: Array.from(zwjLineText.slice(0, zwjUtf16)).length, location: zwjDefinition },
  );
} finally {
  await client.dispose();
  check('dispose reaches terminal disposed status', client.status.value === 'disposed', client.status.value);
  rmSync(workspaceRoot, { recursive: true, force: true });
}

console.log(failures === 0 ? '\ndrive-lsp-real-server: PASS' : `\ndrive-lsp-real-server: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
