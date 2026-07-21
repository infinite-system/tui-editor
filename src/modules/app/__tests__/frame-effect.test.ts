// Verifies the reactive frame effect: an owned $watchEffect re-runs when a load-bearing signal
// changes (so async producers can repaint without a keypress), and stops on $stopEffects.
// Exercises the app invariant "Rendering is one coarse frame effect".
import { test, expect } from 'bun:test';
import { App } from '../App';
import { Editor } from '../../editor/Editor';

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

test('the frame effect re-runs on a document-revision change and stops on $stopEffects', async () => {
  const app = new App.Class() as any;
  const editor = new Editor.Class() as any;

  let runs = 0;
  app.$watchEffect(() => {
    void editor.document.revision.value; // the load-bearing content signal
    runs += 1;
  });

  expect(runs).toBe(1); // ran once at setup

  // A content change (as an async producer or an edit would make) must trigger a repaint.
  editor.document.loadFromText('hello\nworld');
  await flush();
  expect(runs).toBe(2);

  editor.document.setLine(0, 'HELLO');
  await flush();
  expect(runs).toBe(3);

  // After teardown the effect must not fire again (no leaked repaint on a disposed app).
  app.$stopEffects();
  editor.document.loadFromText('after dispose');
  await flush();
  expect(runs).toBe(3);
});

test('a cursor move triggers the frame effect (input-driven repaint)', async () => {
  const app = new App.Class() as any;
  const editor = new Editor.Class() as any;
  editor.document.loadFromText('a\nb\nc\nd');
  (editor as any).hasDocument.value = true;

  let runs = 0;
  app.$watchEffect(() => {
    void editor.cursor.line.value;
    void editor.cursor.col.value;
    runs += 1;
  });
  expect(runs).toBe(1);

  editor.moveVertical(1);
  await flush();
  expect(runs).toBe(2);

  app.$stopEffects();
});
