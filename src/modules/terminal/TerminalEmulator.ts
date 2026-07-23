// The VT emulator: a thin wrapper over @xterm/headless (proven under Bun). It parses the raw ANSI
// byte stream into a rows×cols cell buffer and knows NOTHING about the backend — bytes arrive via
// write(), the emulator's own replies (device-attribute/cursor acks) surface via onReply, and every
// parsed write pulse fires onCellsChanged (the render-coalescing signal). A hand-rolled parser would
// have to re-implement scrollback/wrap/alt-screen, so the library is the honest choice.
//
// invariant: The emulator is the single source of terminal screen state (src/modules/terminal/terminal.invariants.md)
import { Terminal, type IBufferCell } from '@xterm/headless';

/** One cell, flattened to what a cell-grid renderer needs — no xterm types leak past this seam. */
export interface TerminalCell {
  characters: string;
  foreground: number;
  background: number;
  isForegroundDefault: boolean;
  isForegroundRgb: boolean;
  isForegroundPalette: boolean;
  isBackgroundDefault: boolean;
  isBackgroundRgb: boolean;
  isBackgroundPalette: boolean;
  isBold: boolean;
  isInverse: boolean;
  width: number;
}

class $TerminalEmulator {
  private readonly terminal: Terminal;
  private readonly reusableCell: { cell: IBufferCell | undefined } = { cell: undefined };
  private replyCallback: ((data: string) => void) | null = null;
  private cellsChangedCallback: (() => void) | null = null;

  constructor(columns: number, rows: number) {
    this.terminal = new Terminal({
      cols: Math.max(1, columns),
      rows: Math.max(1, rows),
      allowProposedApi: true,
      scrollback: 1000,
    });
    this.terminal.onData((data) => this.replyCallback?.(data));
    this.terminal.onWriteParsed(() => this.cellsChangedCallback?.());
  }

  /** Feed child bytes into the parser. onCellsChanged fires once per parsed pulse (coalescing). */
  write(bytes: Uint8Array | string): void {
    this.terminal.write(bytes as never);
  }

  /** Resolve once all pending writes have been parsed (xterm parses asynchronously). Used by tests
   *  for a deterministic read; production reads flow through onCellsChanged → the frame effect. */
  flush(): Promise<void> {
    return new Promise((resolve) => this.terminal.write('', () => resolve()));
  }

  /** The emulator's OWN replies (cursor/device-attribute reports) that must return to the child. */
  onReply(callback: (data: string) => void): void {
    this.replyCallback = callback;
  }

  /** A parsed-write pulse landed — the cell buffer changed; the owner requests exactly one frame. */
  onCellsChanged(callback: () => void): void {
    this.cellsChangedCallback = callback;
  }

  resize(columns: number, rows: number): void {
    this.terminal.resize(Math.max(1, columns), Math.max(1, rows));
  }

  get columns(): number {
    return this.terminal.cols;
  }

  get rows(): number {
    return this.terminal.rows;
  }

  get cursorColumn(): number {
    return this.terminal.buffer.active.cursorX;
  }

  get cursorRow(): number {
    return this.terminal.buffer.active.cursorY;
  }

  /** Pull one visible cell (viewport row/column) into a flat struct. Reuses a single xterm cell
   *  object across the pull to stay allocation-free per cell — the flyweight viewport-pull.
   *
   *  `row` is VIEWPORT-relative (0 = top visible line). xterm's getLine() indexes the WHOLE buffer
   *  including scrollback, so we add `baseY` (the absolute line of the viewport top when scrolled to
   *  the bottom — the live state, since no scrollback-scroll UI exists yet). This is the same origin
   *  `cursorY` is measured against, so cells and cursor stay aligned. Without the offset, once any
   *  content scrolls into scrollback (baseY > 0 — e.g. after a full-screen alt-screen app like an
   *  editor or Claude Code exits) the pull would read the TOP OF SCROLLBACK: stale artifacts on
   *  screen while live output + the cursor sit below the rendered window (typing appears to vanish). */
  cell(row: number, column: number): TerminalCell | null {
    const active = this.terminal.buffer.active;
    const line = active.getLine(active.baseY + row);
    if (!line) return null;
    const cell = line.getCell(column, this.reusableCell.cell);
    if (!cell) return null;
    this.reusableCell.cell = cell;
    return {
      characters: cell.getChars() || ' ',
      foreground: cell.getFgColor(),
      background: cell.getBgColor(),
      isForegroundDefault: cell.isFgDefault(),
      isForegroundRgb: Boolean(cell.isFgRGB()),
      isForegroundPalette: Boolean(cell.isFgPalette()),
      isBackgroundDefault: cell.isBgDefault(),
      isBackgroundRgb: Boolean(cell.isBgRGB()),
      isBackgroundPalette: Boolean(cell.isBgPalette()),
      isBold: Boolean(cell.isBold()),
      isInverse: Boolean(cell.isInverse()),
      width: cell.getWidth(),
    };
  }

  dispose(): void {
    this.terminal.dispose();
  }
}

export namespace TerminalEmulator {
  export const $Class = $TerminalEmulator;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
