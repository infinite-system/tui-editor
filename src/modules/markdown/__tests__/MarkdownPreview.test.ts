import { test, expect } from 'bun:test';
import { ref } from 'vue';
import { MarkdownPreview } from '../MarkdownPreview';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const makeSource = (text: string) => {
  const revision = ref(1);
  const state = { text };
  return { revision, state, text: () => state.text };
};

// invariant: Parsing starts only after opening (src/modules/markdown/markdown.invariants.md)
test('has no document or rows before open', () => {
  const preview = new MarkdownPreview.Class();
  expect(preview.active.value).toBe(false);
  expect(preview.document.value).toBe(null);
  expect(preview.blocks).toHaveLength(0);
  expect(preview.visibleRows(80, 10)).toHaveLength(0);
});

// invariant: Preview rendering follows visible rows (src/modules/markdown/markdown.invariants.md)
test('renders only the visible window of rows', async () => {
  const body = Array.from({ length: 300 }, (_, index) => `Paragraph number ${index}.`).join('\n\n');
  const preview = new MarkdownPreview.Class();
  preview.open(makeSource(body), null, { debounceMs: 0 });
  await tick();
  await tick();

  const height = 5;
  const rows = preview.visibleRows(80, height);
  expect(rows.length).toBe(height); // never the full document
  expect(preview.totalRows(80)).toBeGreaterThan(height);

  const texts = rows.filter((row) => row.block).map((row) => row.block!.text.slice(row.textStart, row.textEnd));
  expect(texts[0]).toBe('Paragraph number 0.');

  // scrolling shifts the window without materializing more rows than the viewport
  preview.scrollTo(10, 80, height);
  const scrolled = preview.visibleRows(80, height);
  expect(scrolled.length).toBe(height);
  expect(scrolled.some((row) => row.block?.text.includes('Paragraph number 0.'))).toBe(false);
});

// invariant: Markdown panes keep independent find state (src/modules/markdown/markdown.invariants.md)
test('exposes the complete rendered row domain for preview find and selection mapping', async () => {
  const preview = new MarkdownPreview.Class();
  preview.open(makeSource('# Rendered heading\n\nFirst paragraph.\n\nSecond paragraph.'), null, { debounceMs: 0 });
  await tick();
  await tick();

  const allRows = preview.allRows(80);
  expect(allRows.length).toBe(preview.totalRows(80));
  expect(allRows.map((row) => preview.textForRow(row)).join('\n')).toContain('Rendered heading');
  expect(allRows.map((row) => preview.textForRow(row)).join('\n')).not.toContain('# Rendered heading');
});

// invariant: Closing releases all preview work (src/modules/markdown/markdown.invariants.md)
test('close releases the document and leaves no active render effect', async () => {
  const source = makeSource('# Live\n\nbody');
  const preview = new MarkdownPreview.Class();
  let renders = 0;
  const target = { requestRender: () => { renders++; } };
  preview.open(source, target, { debounceMs: 0 });
  await tick();
  await tick();
  expect(preview.active.value).toBe(true);
  const rendersWhileOpen = renders;

  // while open, a source revision change drives the coarse render effect
  source.state.text = '# Live\n\nedited';
  source.revision.value = 2;
  await tick();
  await tick();
  expect(renders).toBeGreaterThan(rendersWhileOpen);

  preview.close();
  expect(preview.active.value).toBe(false);
  expect(preview.document.value).toBe(null);
  expect(preview.visibleRows(80, 10)).toHaveLength(0);

  // after close, further source edits trigger no render (the effect was stopped)
  const rendersAfterClose = renders;
  source.state.text = '# Live\n\nafter close';
  source.revision.value = 3;
  await tick();
  await tick();
  expect(renders).toBe(rendersAfterClose);
});
