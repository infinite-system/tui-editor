// Half-block image rendering: a decoded image is drawn into the truecolor cell grid using the glyph
// ▀ (U+2580 upper half block) so ONE cell encodes TWO vertically-stacked full-colour pixels — the
// cell's foreground is the top pixel, its background is the bottom pixel. A pane of columns×rows cells
// therefore shows columns×(2·rows) pixels. The image is box-downsampled to the fitted subpixel grid
// (aspect preserved, since a subpixel is square when sampled columns wide × 2·rows tall), composited
// over the panel background for alpha, and letterboxed with panel-background cells. Runs of identically
// styled cells coalesce into one chunk, mirroring the other pane renderers. Pure and stateless.
//
// invariant: A raster image renders as half-block cells sized to the pane (src/modules/image/image.invariants.md)
import { StyledText, fg, bg, type TextChunk } from '@opentui/core';
import { Static } from 'ivue/extras';
import type { DecodedImage } from './ImageDecoders';
import { ImageResample } from './ImageResample';

/** The upper-half-block glyph: foreground paints the top pixel, background the bottom pixel. */
const UPPER_HALF_BLOCK = '▀';

export interface HalfBlockRenderContext {
  image: DecodedImage;
  /** Target cell columns of the pane. */
  columns: number;
  /** Target cell rows of the pane (each row is two vertically-stacked pixels tall). */
  rows: number;
  /** The panel background as `#rrggbb` — used for letterbox cells and alpha compositing. */
  panelBackground: string;
}

export interface HalfBlockRender {
  styledText: StyledText;
  /** Cell columns actually occupied by the fitted image (≤ columns). */
  columns: number;
  /** Cell rows actually occupied by the fitted image (≤ rows). */
  rows: number;
}

class $HalfBlockRenderer {
  static render = $render;
}

export namespace HalfBlockRenderer {
  export const $Class = $HalfBlockRenderer;
  export const Class = Static($HalfBlockRenderer);
}

/** Parse `#rrggbb` (or `rrggbb`) into an [red, green, blue] triple, defaulting to black on a bad string. */
function parseHexColor(hex: string): [number, number, number] {
  const normalized = hex.startsWith('#') ? hex.slice(1) : hex;
  if (normalized.length < 6) return [0, 0, 0];
  const packed = Number.parseInt(normalized.slice(0, 6), 16);
  if (Number.isNaN(packed)) return [0, 0, 0];
  return [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff];
}

function componentToHex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
}

function rgbToHex(red: number, green: number, blue: number): string {
  return `#${componentToHex(red)}${componentToHex(green)}${componentToHex(blue)}`;
}

function $render(context: HalfBlockRenderContext): HalfBlockRender {
  const { image, panelBackground } = context;
  const columns = Math.max(1, context.columns);
  const rows = Math.max(1, context.rows);
  const [backgroundRed, backgroundGreen, backgroundBlue] = parseHexColor(panelBackground);
  const panelHex = rgbToHex(backgroundRed, backgroundGreen, backgroundBlue);

  // Fit the source into a columns × (2·rows) subpixel box, preserving aspect (a subpixel is square),
  // then box-average + composite through the shared resample seam — the same generator the pixel
  // tiers consume, at subpixel units.
  const subpixelRows = rows * 2;
  const fitted = ImageResample.Class.fitWithin(image.width, image.height, columns, subpixelRows);
  const fittedWidth = fitted.width;
  const fittedHeightSubpixels = fitted.height;
  const grid = ImageResample.Class.toRgbGrid(
    image, fittedWidth, fittedHeightSubpixels, backgroundRed, backgroundGreen, backgroundBlue,
  );

  // Centre the fitted image inside the pane; cells outside it are painted the panel background.
  const offsetColumns = Math.floor((columns - fittedWidth) / 2);
  const offsetSubpixelRows = Math.floor((subpixelRows - fittedHeightSubpixels) / 2);
  // The hex of the fitted subpixel at (fittedX, fittedY), or the panel background when outside the image.
  const subpixelHex = (paneColumn: number, paneSubpixelRow: number): string => {
    const fittedX = paneColumn - offsetColumns;
    const fittedY = paneSubpixelRow - offsetSubpixelRows;
    if (fittedX < 0 || fittedX >= fittedWidth || fittedY < 0 || fittedY >= fittedHeightSubpixels) return panelHex;
    const gridOffset = (fittedY * fittedWidth + fittedX) * 3;
    return rgbToHex(grid[gridOffset]!, grid[gridOffset + 1]!, grid[gridOffset + 2]!);
  };

  const chunks: TextChunk[] = [];
  for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
    let runText = '';
    let runKey = '';
    let runTopHex = '';
    let runBottomHex = '';
    const flushRun = (): void => {
      if (runText) chunks.push(fg(runTopHex)(bg(runBottomHex)(runText)));
      runText = '';
      runKey = '';
    };
    for (let columnIndex = 0; columnIndex < columns; columnIndex++) {
      const topHex = subpixelHex(columnIndex, rowIndex * 2);
      const bottomHex = subpixelHex(columnIndex, rowIndex * 2 + 1);
      const cellKey = `${topHex}:${bottomHex}`;
      if (runText && cellKey !== runKey) flushRun();
      runText += UPPER_HALF_BLOCK;
      runKey = cellKey;
      runTopHex = topHex;
      runBottomHex = bottomHex;
    }
    flushRun();
    if (rowIndex < rows - 1) chunks.push(fg(panelHex)('\n'));
  }

  return {
    styledText: new StyledText(chunks),
    columns: fittedWidth,
    rows: Math.ceil(fittedHeightSubpixels / 2),
  };
}
