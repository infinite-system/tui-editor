// The terminal pane renderer: pulls the emulator's visible rows×cols cell grid per frame into a
// StyledText, coalescing runs of same-styled cells into one chunk (flyweight viewport-pull — the same
// shape as TreePaneRenderer / GitPaneRenderer, no per-cell renderable, no dirty-region bookkeeping).
// Stateless Static capability: every read flows through the passed-in TerminalInstance, so reactivity
// flows when the owner calls render() inside its reactive update.
//
// invariant: The panel renders exactly the active pane content cells each frame (src/modules/terminal/terminal.invariants.md)
// invariant: The emulator is the single source of terminal screen state (src/modules/terminal/terminal.invariants.md)
import { StyledText, fg, bg, bold, type TextChunk } from '@opentui/core';
import { Static } from 'ivue/extras';
import type { Palette } from '../theme/ThemePalettes';
import type { TerminalInstance } from './TerminalInstance';
import type { TerminalCell } from './TerminalEmulator';

export interface TerminalPaneRenderContext {
  instance: TerminalInstance.Instance;
  palette: Palette;
  /** Available cell rows for the terminal body (the whole pane region, gutter included). */
  height: number;
  /** Available cell columns for the terminal body (the whole pane region, gutter included). */
  width: number;
  /** Left/right gutter columns kept blank around the emulator (default 0). */
  padColumns?: number;
  /** Top/bottom gutter rows kept blank around the emulator (default 0). */
  padRows?: number;
}

// The 16 standard ANSI palette colors (0–15) as hex. 256-color indices 16–255 are computed from the
// 6×6×6 cube and the grayscale ramp — the standard xterm mapping — so real terminal colors render.
const ANSI_16 = [
  '#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#c0c0c0',
  '#808080', '#ff0000', '#00ff00', '#ffff00', '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
];

function toHex(value: number): string {
  return value.toString(16).padStart(2, '0');
}

function paletteToHex(index: number): string {
  if (index < 16) return ANSI_16[index] ?? '#c0c0c0';
  if (index < 232) {
    const cubeIndex = index - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const red = steps[Math.floor(cubeIndex / 36) % 6] ?? 0;
    const green = steps[Math.floor(cubeIndex / 6) % 6] ?? 0;
    const blue = steps[cubeIndex % 6] ?? 0;
    return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
  }
  const gray = 8 + (index - 232) * 10;
  return `#${toHex(gray)}${toHex(gray)}${toHex(gray)}`;
}

function rgbToHex(value: number): string {
  return `#${toHex((value >> 16) & 0xff)}${toHex((value >> 8) & 0xff)}${toHex(value & 0xff)}`;
}

/** The cell's foreground color as a hex string, honoring RGB / palette / default. */
function foregroundHex(cell: TerminalCell, palette: Palette): string {
  if (cell.isForegroundRgb) return rgbToHex(cell.foreground);
  if (cell.isForegroundPalette) return paletteToHex(cell.foreground);
  return palette.fg;
}

/** The cell's background color as a hex string, or null when it is the default panel background. */
function backgroundHex(cell: TerminalCell, panelBackground: string): string | null {
  if (cell.isBackgroundRgb) return rgbToHex(cell.background);
  if (cell.isBackgroundPalette) return paletteToHex(cell.background);
  return panelBackground;
}

function styleKey(cell: TerminalCell): string {
  return `${cell.foreground}:${cell.background}:${cell.isForegroundRgb}:${cell.isForegroundPalette}:${cell.isBackgroundRgb}:${cell.isBackgroundPalette}:${cell.isBold}:${cell.isInverse}`;
}

function chunkFor(text: string, cell: TerminalCell, palette: Palette): TextChunk {
  let foreground = foregroundHex(cell, palette);
  let background = backgroundHex(cell, palette.panel);
  if (cell.isInverse) {
    const swap = background ?? palette.panel;
    background = foreground;
    foreground = swap;
  }
  let chunk = fg(foreground)(text);
  if (cell.isBold) chunk = bold(chunk);
  if (background && background !== palette.panel) chunk = bg(background)(chunk);
  return chunk;
}

function $render(context: TerminalPaneRenderContext): StyledText {
  const { instance, palette } = context;
  const padColumns = Math.max(0, context.padColumns ?? 0);
  const padRows = Math.max(0, context.padRows ?? 0);
  // The emulator draws into the region INSIDE the gutter; the outer margin stays panel background.
  const rows = Math.min(Math.max(0, context.height - 2 * padRows), instance.rows);
  const columns = Math.min(Math.max(0, context.width - 2 * padColumns), instance.columns);
  const leadingGutter = padColumns > 0 ? ' '.repeat(padColumns) : '';
  // Build each emulator row's coalesced chunks, then frame with blank gutter rows + a left margin.
  const rowChunkLists: TextChunk[][] = [];
  for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
    const rowChunks: TextChunk[] = [];
    if (leadingGutter) rowChunks.push(fg(palette.fg)(leadingGutter));
    let runText = '';
    let runCell: TerminalCell | null = null;
    let runKey = '';
    const flushRun = () => {
      if (runCell && runText) rowChunks.push(chunkFor(runText, runCell, palette));
      runText = '';
      runCell = null;
      runKey = '';
    };
    let columnIndex = 0;
    while (columnIndex < columns) {
      const cell = instance.cell(rowIndex, columnIndex) ?? {
        characters: ' ', foreground: 0, background: 0,
        isForegroundDefault: true, isForegroundRgb: false, isForegroundPalette: false,
        isBackgroundDefault: true, isBackgroundRgb: false, isBackgroundPalette: false,
        isBold: false, isInverse: false, width: 1,
      };
      const key = styleKey(cell);
      if (runCell && key !== runKey) flushRun();
      runText += cell.characters;
      runCell = cell;
      runKey = key;
      // A wide (2-cell) glyph occupies the next column with a 0-width spacer xterm returns as ''.
      columnIndex += Math.max(1, cell.width);
    }
    flushRun();
    rowChunkLists.push(rowChunks);
  }
  // Frame: padRows blank rows, then the gutter-indented content rows, then padRows blank rows.
  const framedRows: TextChunk[][] = [];
  for (let blank = 0; blank < padRows; blank += 1) framedRows.push([]);
  for (const rowChunks of rowChunkLists) framedRows.push(rowChunks);
  for (let blank = 0; blank < padRows; blank += 1) framedRows.push([]);
  const chunks: TextChunk[] = [];
  for (let rowIndex = 0; rowIndex < framedRows.length; rowIndex += 1) {
    chunks.push(...(framedRows[rowIndex] as TextChunk[]));
    if (rowIndex < framedRows.length - 1) chunks.push(fg(palette.fg)('\n'));
  }
  return new StyledText(chunks);
}

class $TerminalPaneRenderer {
  static render = $render;
}

export namespace TerminalPaneRenderer {
  export const $Class = $TerminalPaneRenderer;
  export const Class = Static($TerminalPaneRenderer);
}
