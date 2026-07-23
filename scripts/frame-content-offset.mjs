#!/usr/bin/env bun
// Height-robust layout probe for the driven smokes.
//
// The workspace tab strip sits at the very top of the frame and contains no box-drawing characters;
// the main UI below it (buffer tab bar, file tree, editor, git panels) is framed with box-drawing
// borders, so the FIRST row that contains a box-drawing glyph is the row where the workspace strip
// ends and the panel area begins. That row index equals the workspace strip's height.
//
// The smokes were authored when the strip was ONE row tall (its box area started at row 1). When the
// strip grows (the two-line workspace tabs made it 2 rows), every click/row coordinate below it shifts
// down by the same amount. This prints that shift — (firstBoxRow - 1) — so a smoke can add it to every
// coordinate it targets below the workspace strip and stay correct at any strip height (0 when 1 row).
//
// Usage: bun scripts/frame-content-offset.mjs <frame-json-path>
import { readFileSync } from 'node:fs';

const framePath = process.argv[2];
const boxDrawing = /[─-╿]/;
try {
  const frame = JSON.parse(readFileSync(framePath, 'utf8'));
  const rows = frame.rows ?? [];
  let firstBoxRow = 0;
  while (firstBoxRow < rows.length && !boxDrawing.test(rows[firstBoxRow].text ?? '')) {
    firstBoxRow += 1;
  }
  process.stdout.write(String(Math.max(0, firstBoxRow - 1)));
} catch {
  process.stdout.write('0');
}
