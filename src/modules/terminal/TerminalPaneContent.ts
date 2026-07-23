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
    return { column: this.instance.cursorColumn, row: this.instance.cursorRow };
  }

  onResize(columns: number, rows: number): void {
    this.instance.resize(columns, rows);
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
