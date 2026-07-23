// A minimal, self-contained PaneContent: it renders its own title, the sub-region it was last handed,
// its focus state, and the last key it received. It carries no backend and no async work, so it is the
// deterministic second occupant used to PROVE the split slot end to end — two of these (or one of these
// beside the terminal) demonstrate that each cell renders into its OWN sub-region, that only the
// focused cell receives keys, and that dragging the divider re-sizes both. It also doubles as a
// placeholder for a not-yet-wired cell. All PaneContent obligations, nothing terminal-specific.
//
// invariant: A split panel renders every visible cell into its own sub-region (src/modules/terminal/terminal.invariants.md)
import { StyledText, fg, type TextChunk } from '@opentui/core';
import type { KeyEvent } from '@opentui/core';
import { ref, type Ref } from 'vue';
import type { PaneContent, PaneRenderContext } from './PaneContent';

class $StaticPaneContent implements PaneContent {
  readonly renderRevision: Ref<number> = ref(0);

  /** The sub-region size this cell was last converged to — rendered verbatim so a driving test can read
   *  each cell's ACTUAL columns×rows off the frame and confirm the panes were sized independently. */
  private lastColumns = 0;
  private lastRows = 0;
  private isFocused = false;
  private lastKey = '';

  constructor(
    readonly id: string,
    readonly title: string,
    readonly icon?: string,
  ) {}

  render(context: PaneRenderContext): StyledText {
    const color = context.focused ? context.palette.accent : context.palette.fg;
    const lines = [
      `${this.title} ${context.width}x${context.height}`,
      context.focused ? 'focused' : 'blurred',
      this.lastKey ? `key:${this.lastKey}` : 'key:-',
    ];
    const chunks: TextChunk[] = [];
    lines.forEach((line, index) => {
      chunks.push(fg(color)(line));
      if (index < lines.length - 1) chunks.push(fg(color)('\n'));
    });
    return new StyledText(chunks);
  }

  caret(): { column: number; row: number } | null {
    return this.isFocused ? { column: 0, row: 0 } : null;
  }

  handleKey(key: KeyEvent): boolean {
    this.lastKey = key.name ?? key.sequence ?? '?';
    this.renderRevision.value += 1;
    return true;
  }

  onResize(columns: number, rows: number): void {
    this.lastColumns = columns;
    this.lastRows = rows;
    this.renderRevision.value += 1;
  }

  onFocus(): void {
    this.isFocused = true;
    this.renderRevision.value += 1;
  }

  onBlur(): void {
    this.isFocused = false;
    this.renderRevision.value += 1;
  }

  dispose(): void {
    /* nothing to release */
  }
}

export namespace StaticPaneContent {
  export const $Class = $StaticPaneContent;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
