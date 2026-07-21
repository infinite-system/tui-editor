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
  // Preferred column for up/down movement across short lines.
  get goalCol() {
    return ref(0);
  }
  // Selection anchor (the fixed end); null when there is no selection.
  get anchor() {
    return shallowRef<Position | null>(null);
  }

  set(line: number, col: number): void {
    this.line.value = Math.max(0, line);
    this.col.value = Math.max(0, col);
    this.goalCol.value = this.col.value;
  }

  setLinePreserveGoal(line: number, lineLength: number): void {
    this.line.value = Math.max(0, line);
    this.col.value = Math.min(this.goalCol.value, lineLength);
  }

  setAnchorHere(): void {
    this.anchor.value = { line: this.line.value, col: this.col.value };
  }

  clearSelection(): void {
    this.anchor.value = null;
  }

  get hasSelection(): boolean {
    const a = this.anchor.value;
    return a !== null && (a.line !== this.line.value || a.col !== this.col.value);
  }

  /** Normalized selection {start <= end}, or null if there is no non-empty selection. */
  selectionRange(): { start: Position; end: Position } | null {
    const a = this.anchor.value;
    if (!a) return null;
    const c: Position = { line: this.line.value, col: this.col.value };
    if (a.line === c.line && a.col === c.col) return null;
    const aFirst = a.line < c.line || (a.line === c.line && a.col < c.col);
    return aFirst ? { start: a, end: c } : { start: c, end: a };
  }
}

export namespace Cursor {
  export const $Class = $Cursor;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
  export type Model = InstanceType<typeof Class>;
}
