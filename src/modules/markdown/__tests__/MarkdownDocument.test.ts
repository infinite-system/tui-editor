import { test, expect } from 'bun:test';
import { Reactive } from 'ivue';
import { ref } from 'vue';
import { MarkdownDocument } from '../MarkdownDocument';
import type { BlockRecord, MarkdownParseResult, MarkdownParser } from '../MarkdownParser';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const block = (text: string): BlockRecord => ({
  kind: 'paragraph',
  text,
  spans: [],
  links: [],
  range: { startLine: 0, endLine: 1, startOffset: 0, endOffset: text.length },
});

/** A parser whose async results are resolved by hand, so revision races are deterministic. */
class DeferredParser {
  readonly pending: { revision: number; resolve: (r: MarkdownParseResult) => void }[] = [];
  parseCount = 0;
  disposed = 0;
  parse(_text: string, revision = 0): MarkdownParseResult {
    return { revision, blocks: [] };
  }
  parseAsync(_text: string, revision: number): Promise<MarkdownParseResult> {
    this.parseCount++;
    return new Promise((resolve) => this.pending.push({ revision, resolve }));
  }
  settle(revision: number, blocks: BlockRecord[]): void {
    this.pending.find((entry) => entry.revision === revision)!.resolve({ revision, blocks });
  }
  dispose(): void {
    this.disposed++;
  }
}

// Exercises the createParser() construction seam (Construction goes through overridable seams).
class $TestDocument extends MarkdownDocument.$Class {
  parserCreated = 0;
  lastParser: DeferredParser | null = null;
  protected override createParser() {
    this.parserCreated++;
    this.lastParser = new DeferredParser();
    return this.lastParser as unknown as MarkdownParser.Model;
  }
}
const TestDocument = Reactive($TestDocument);

const makeSource = (initial = 1) => {
  const revision = ref(initial);
  const state = { text: 'seed' };
  return { revision, state, text: () => state.text };
};

// invariant: Parsing starts only after opening (src/modules/markdown/markdown.invariants.md)
test('does not parse or allocate a parser before open', async () => {
  const source = makeSource();
  const document = new TestDocument(source, { debounceMs: 0 });

  expect(document.opened.value).toBe(false);
  expect(document.revision.value).toBe(-1);
  expect(document.blocks.value).toHaveLength(0);
  expect(document.parserCreated).toBe(0);

  // mutating the source before open must not arm any parse (no watcher exists yet)
  source.revision.value = 5;
  await tick();
  expect(document.parserCreated).toBe(0);
  expect(document.revision.value).toBe(-1);
});

// invariant: Parsing starts only after opening (src/modules/markdown/markdown.invariants.md)
test('parses the source after open', async () => {
  const source = makeSource(3);
  const document = new TestDocument(source, { debounceMs: 0 });
  document.open();
  expect(document.parserCreated).toBe(1);
  await tick();
  document.lastParser!.settle(3, [block('hello')]);
  await tick();
  expect(document.revision.value).toBe(3);
  expect(document.blocks.value.map((block) => block.text)).toEqual(['hello']);
});

// invariant: Applied blocks match the current revision (src/modules/markdown/markdown.invariants.md)
test('discards a stale parse whose revision no longer matches the source', async () => {
  const source = makeSource(1);
  const document = new TestDocument(source, { debounceMs: 0 });
  document.open();
  await tick(); // startParse(rev 1) is now awaiting the deferred parser

  // source advances to revision 2 while the rev-1 parse is still in flight
  source.state.text = 'updated';
  source.revision.value = 2; // sync watch → schedules parse(rev 2)
  await tick(); // startParse(rev 2) now awaiting

  // the STALE result (rev 1) resolves first — it must be dropped, never applied
  document.lastParser!.settle(1, [block('STALE')]);
  await tick();
  expect(document.revision.value).toBe(-1); // nothing applied yet
  expect(document.blocks.value).toHaveLength(0);

  // the current result (rev 2) resolves and IS applied
  document.lastParser!.settle(2, [block('FRESH')]);
  await tick();
  expect(document.revision.value).toBe(2);
  expect(document.blocks.value.map((block) => block.text)).toEqual(['FRESH']);
  // the stale block never reached the model
  expect(document.blocks.value.some((block) => block.text === 'STALE')).toBe(false);
});

// invariant: Closing releases all preview work (src/modules/markdown/markdown.invariants.md)
test('close disposes the parser stops effects and resets state', async () => {
  const source = makeSource(4);
  const document = new TestDocument(source, { debounceMs: 0 });
  document.open();
  await tick();
  document.lastParser!.settle(4, [block('body')]);
  await tick();
  expect(document.blocks.value).toHaveLength(1);

  const parser = document.lastParser!;
  document.close();
  expect(document.opened.value).toBe(false);
  expect(document.revision.value).toBe(-1);
  expect(document.blocks.value).toHaveLength(0);
  expect(parser.disposed).toBe(1);

  // after close the source watcher is gone: further edits arm no parse
  const parsesBefore = parser.parseCount;
  source.state.text = 'ignored';
  source.revision.value = 99;
  await tick();
  expect(parser.parseCount).toBe(parsesBefore);
  expect(document.parserCreated).toBe(1); // no new parser materialized
});
