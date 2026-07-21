// Undo/redo as a bounded stack of document snapshots with time+kind coalescing, so a run of
// typed characters collapses into one undo step. Snapshot-based (correct and simple); a
// piece-table delta store is the performance refinement (see KNOWN_LIMITATIONS.md).
//
// invariant: Cost tracks the actively observed set (project.invariants.md)
//   — the stack is bounded (MAX_DEPTH); the oldest states are evicted, not retained forever.

export type EditKind = 'insert' | 'delete' | 'newline' | 'paste' | 'other';

export interface UndoState {
  lines: string[];
  cursor: { line: number; col: number };
  kind: EditKind;
  at: number;
}

const MAX_DEPTH = 500;
const COALESCE_MS = 400;

class $UndoStore {
  private undoStack: UndoState[] = [];
  private redoStack: UndoState[] = [];

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get depth(): number {
    return this.undoStack.length;
  }

  /**
   * Record the state BEFORE an edit. Coalesces with the previous record when the edit is the
   * same kind and within COALESCE_MS (typing runs become one step). `now` is injected so the
   * store is deterministically testable.
   */
  record(state: UndoState, now: number): void {
    this.redoStack = [];
    const previous = this.undoStack[this.undoStack.length - 1];
    if (
      previous &&
      previous.kind === state.kind &&
      (state.kind === 'insert' || state.kind === 'delete') &&
      now - previous.at < COALESCE_MS
    ) {
      // Keep the earlier pre-edit state; just refresh its timestamp so the run keeps coalescing.
      previous.at = now;
      return;
    }
    this.undoStack.push(state);
    if (this.undoStack.length > MAX_DEPTH) this.undoStack.shift();
  }

  /** Pop an undo state; caller must pass the CURRENT state to push onto redo. */
  undo(current: UndoState): UndoState | null {
    const target = this.undoStack.pop();
    if (!target) return null;
    this.redoStack.push(current);
    return target;
  }

  /** Pop a redo state; caller passes the CURRENT state to push back onto undo. */
  redo(current: UndoState): UndoState | null {
    const target = this.redoStack.pop();
    if (!target) return null;
    this.undoStack.push(current);
    return target;
  }
}

export namespace UndoStore {
  export const $Class = $UndoStore;
  export let Class = $UndoStore;
  export type Instance = InstanceType<typeof $UndoStore>;
}
