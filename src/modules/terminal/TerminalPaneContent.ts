// The terminal as a PaneContent — the adapter that makes a TerminalInstance a first-class occupant of
// the composable PanelHost. It is thin by design: render() delegates to TerminalPaneRenderer,
// handleKey() encodes the keystroke (TerminalKeys) and writes it through the instance's backend seam,
// onResize() maps the panel's cell region to a terminal resize, and renderRevision re-exposes the
// instance's paint signal. All terminal-specific knowledge lives below the seam; the host sees only a
// generic PaneContent.
//
// invariant: A focused panel routes keystrokes to its active pane content (src/modules/terminal/terminal.invariants.md)
// invariant: The panel renders exactly the active pane content cells each frame (src/modules/terminal/terminal.invariants.md)
import type { StyledText } from '@opentui/core';
import type { KeyEvent } from '@opentui/core';
import type { Ref } from 'vue';
import type { PaneContent, PaneRenderContext } from '../ui/PaneContent';
import { TerminalPaneRenderer } from './TerminalPaneRenderer';
import { TerminalKeys } from './TerminalKeys';
import type { TerminalInstance } from './TerminalInstance';

// The terminal pane's gutter: a 2-column left/right margin and a 1-row top/bottom margin around the
// emulator, so the shell doesn't hug the panel border. The emulator (and thus the child PTY) sizes to
// the VISIBLE region inside the gutter; the caret and rendered cells shift by the same margin. Kept in
// ONE place so render(), onResize(), and caret() agree — a mismatch would put the cursor off the text.
const TERMINAL_PAD_COLUMNS = 2;
const TERMINAL_PAD_ROWS = 1;

class $TerminalPaneContent implements PaneContent {
  readonly id = 'terminal';
  readonly icon = '❯'; // ❯

  constructor(private readonly instance: TerminalInstance.Instance) {}

  get title(): string {
    return this.instance.exited.value ? `${this.instance.title} (exited)` : this.instance.title;
  }

  get renderRevision(): Ref<number> {
    return this.instance.renderRevision;
  }

  render(context: PaneRenderContext): StyledText {
    return TerminalPaneRenderer.Class.render({
      instance: this.instance,
      palette: context.palette,
      width: context.width,
      height: context.height,
      padColumns: TERMINAL_PAD_COLUMNS,
      padRows: TERMINAL_PAD_ROWS,
    });
  }

  handleKey(key: KeyEvent): boolean {
    const bytes = TerminalKeys.Class.encode(key);
    if (!bytes) return false;
    this.instance.sendInput(bytes);
    return true;
  }

  /** A paste while the terminal is focused: deliver the text to the child as raw input — the same
   *  bytes as if the user had typed the pasted/dictated text. */
  handlePaste(text: string): boolean {
    if (!text) return false;
    this.instance.sendInput(text);
    return true;
  }

  caret(): { column: number; row: number } | null {
    if (this.instance.exited.value) return null;
    // Shift by the gutter so the block cursor lands on the padded cell, not the pane origin.
    return {
      column: this.instance.cursorColumn + TERMINAL_PAD_COLUMNS,
      row: this.instance.cursorRow + TERMINAL_PAD_ROWS,
    };
  }

  onResize(columns: number, rows: number): void {
    // Size the emulator (and the child PTY) to the VISIBLE region inside the gutter, so `stty size`
    // reports the padded dimensions and no cell is drawn under the margin.
    this.instance.resize(
      Math.max(1, columns - 2 * TERMINAL_PAD_COLUMNS),
      Math.max(1, rows - 2 * TERMINAL_PAD_ROWS),
    );
  }

  onFocus(): void {
    /* the terminal has no focus-specific state for tier S; the caret follows the emulator */
  }

  onBlur(): void {
    /* no-op */
  }

  dispose(): void {
    this.instance.dispose();
  }
}

export namespace TerminalPaneContent {
  export const $Class = $TerminalPaneContent;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
