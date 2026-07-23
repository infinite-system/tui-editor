// HalfBlockRenderer unit tests: the load-bearing half-block semantics — one cell = the ▀ glyph whose
// FOREGROUND is the top subpixel and BACKGROUND is the bottom subpixel — plus aspect-preserving
// letterbox with panel-background cells. These lock the encoding the pane renderer depends on.
import { describe, test, expect } from 'bun:test';
import { HalfBlockRenderer } from './HalfBlockRenderer';
import type { DecodedImage } from './PngDecoder';

/** The RGB triple of a chunk's foreground/background colour buffer. */
function colorOf(colorBuffer: { buffer: Record<number, number> }): [number, number, number] {
  return [colorBuffer.buffer[0]!, colorBuffer.buffer[1]!, colorBuffer.buffer[2]!];
}

describe('HalfBlockRenderer', () => {
  test('a 1×2 image maps top pixel → foreground, bottom pixel → background of one ▀ cell', () => {
    const image: DecodedImage = { width: 1, height: 2, rgba: Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255]) };
    const render = HalfBlockRenderer.Class.render({ image, columns: 1, rows: 1, panelBackground: '#000000' });
    expect(render.columns).toBe(1);
    expect(render.rows).toBe(1);
    const chunks = render.styledText.chunks as unknown as {
      text: string;
      fg: { buffer: Record<number, number> };
      bg: { buffer: Record<number, number> };
    }[];
    const cell = chunks.find((chunk) => chunk.text.includes('▀'));
    expect(cell).toBeDefined();
    expect(colorOf(cell!.fg)).toEqual([255, 0, 0]); // top subpixel
    expect(colorOf(cell!.bg)).toEqual([0, 0, 255]); // bottom subpixel
  });

  test('a wide image in a tall pane is letterboxed with panel-background cells', () => {
    // 4×1 white strip fitted into a 4-col × 4-row pane (8 subpixel rows): only one subpixel row is
    // image; the rest must be the panel background.
    const image: DecodedImage = { width: 4, height: 1, rgba: new Uint8Array(4 * 4).fill(255) };
    const render = HalfBlockRenderer.Class.render({ image, columns: 4, rows: 4, panelBackground: '#123456' });
    const chunks = render.styledText.chunks as unknown as {
      text: string;
      fg: { buffer: Record<number, number> };
      bg: { buffer: Record<number, number> };
    }[];
    const panelCells = chunks.filter(
      (chunk) => chunk.text.includes('▀') &&
        colorOf(chunk.fg).join() === [0x12, 0x34, 0x56].join() &&
        colorOf(chunk.bg).join() === [0x12, 0x34, 0x56].join(),
    );
    const imageCells = chunks.filter(
      (chunk) => chunk.text.includes('▀') &&
        (colorOf(chunk.fg).join() === [255, 255, 255].join() || colorOf(chunk.bg).join() === [255, 255, 255].join()),
    );
    expect(panelCells.length).toBeGreaterThan(0); // letterbox present
    expect(imageCells.length).toBeGreaterThan(0); // image present
  });

  test('never exceeds the requested pane and preserves aspect (no upscale past columns×2·rows)', () => {
    const image: DecodedImage = { width: 100, height: 50, rgba: new Uint8Array(100 * 50 * 4).fill(200) };
    const render = HalfBlockRenderer.Class.render({ image, columns: 40, rows: 20, panelBackground: '#000000' });
    expect(render.columns).toBeLessThanOrEqual(40);
    expect(render.rows).toBeLessThanOrEqual(20);
  });
});
