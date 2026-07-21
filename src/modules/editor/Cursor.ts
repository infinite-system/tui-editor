// Cursor position (line/col, 0-based) plus a goal column for vertical movement.
// invariant: A text position has several encodings (project.invariants.md)
//   — line/col here are LOGICAL character positions; display-column mapping is the view's job.
import { Reactive } from 'ivue';
import { ref } from 'vue';

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

  set(line: number, col: number): void {
    this.line.value = Math.max(0, line);
    this.col.value = Math.max(0, col);
    this.goalCol.value = this.col.value;
  }

  setLinePreserveGoal(line: number, lineLength: number): void {
    this.line.value = Math.max(0, line);
    this.col.value = Math.min(this.goalCol.value, lineLength);
  }
}

export namespace Cursor {
  export const $Class = $Cursor;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
