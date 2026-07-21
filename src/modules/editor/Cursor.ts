// Cursor position (line/col, 0-based; col = grapheme index) plus a goal column for vertical
// movement and an optional selection anchor.
// invariant: A cursor position resolves to three distinct coordinates (editor.invariants.md)
//   — line/col are grapheme positions; display-column mapping is the view's job.
import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';

export interface Position {
  line: number;
  col: number;
}

class $Cursor {
  get line() {
    return ref(0);
  }
  get col() {
    return ref(0);
  }
  // Preferred column for up/down movement, in DISPLAY columns (visual x, tab/wide aware) — the
  // goal survives whole vertical runs and only the landing column clamps to shorter lines.
  get goalColumn() {
    return ref(0);
  }
  // Selection anchor (the fixed end); null when there is no selection.
  get anchor() {
    return shallowRef<Position | null>(null);
  }

  /**
   * Place the cursor. `goalDisplayColumn` is the visual x this position corresponds to (the owner
   * computes it via the coordinate model); defaults to the grapheme column for plain-ASCII callers.
   */
  set(line: number, column: number, goalDisplayColumn = column): void {
    this.line.value = Math.max(0, line);
    this.col.value = Math.max(0, column);
    this.goalColumn.value = Math.max(0, goalDisplayColumn);
  }

  /** Vertical landing: move to `line` at `column` WITHOUT touching the goal (it survives the run). */
  moveToLineKeepingGoal(line: number, column: number): void {
    this.line.value = Math.max(0, line);
    this.col.value = Math.max(0, column);
  }

  setAnchorHere(): void {
    this.anchor.value = { line: this.line.value, col: this.col.value };
  }

  clearSelection(): void {
    this.anchor.value = null;
  }

  get hasSelection(): boolean {
    const anchorPosition = this.anchor.value;
    return anchorPosition !== null && (anchorPosition.line !== this.line.value || anchorPosition.col !== this.col.value);
  }

  /** Normalized selection {start <= end}, or null if there is no non-empty selection. */
  selectionRange(): { start: Position; end: Position } | null {
    const anchorPosition = this.anchor.value;
    if (!anchorPosition) return null;
    const cursorPosition: Position = { line: this.line.value, col: this.col.value };
    if (anchorPosition.line === cursorPosition.line && anchorPosition.col === cursorPosition.col) return null;
    const anchorFirst =
      anchorPosition.line < cursorPosition.line ||
      (anchorPosition.line === cursorPosition.line && anchorPosition.col < cursorPosition.col);
    return anchorFirst
      ? { start: anchorPosition, end: cursorPosition }
      : { start: cursorPosition, end: anchorPosition };
  }
}

export namespace Cursor {
  export const $Class = $Cursor;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
  export type Model = InstanceType<typeof Class>;
}
