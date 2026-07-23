// Browser-style navigation history (VS Code "Go Back / Go Forward"): an ordered list of visited
// locations plus a cursor into it. Recording a NEW location truncates any forward history and
// appends; back()/forward() walk the cursor without recording. Pure model — plain values in, plain
// values out — so it is unit-testable with no editor, no LSP, and no terminal.
//
// invariant: Programmatic history navigation does not record new history (navigation.invariants.md)
import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';

/** One visited location: a document and the cursor's 0-based grapheme position within it. */
export interface Location {
  documentPath: string;
  line: number;
  column: number;
}

/** The largest number of entries retained; recording past it drops the oldest (bounded memory). */
const MAXIMUM_ENTRY_COUNT = 100;

class $NavigationHistory {
  // The ordered list of visited locations, oldest first. shallowRef because it is replaced
  // wholesale on every mutation (never mutated in place), so one signal covers the whole list.
  get entries() {
    return shallowRef<Location[]>([]);
  }
  // Index into entries of the location currently shown; -1 while the history is empty. back()/
  // forward() move ONLY this index — the observable enabled/disabled state derives from it.
  get currentIndex() {
    return ref(-1);
  }

  /** The location currently shown, or null when the history is empty. */
  get currentEntry(): Location | null {
    const index = this.currentIndex.value;
    return index >= 0 ? this.entries.value[index] ?? null : null;
  }

  /** Whether back() would move (there is an older location to return to). */
  get canGoBack(): boolean {
    return this.currentIndex.value > 0;
  }
  /** Whether forward() would move (there is a newer location to return to). */
  get canGoForward(): boolean {
    return this.currentIndex.value < this.entries.value.length - 1;
  }
  /** How many locations are recorded. */
  get size(): number {
    return this.entries.value.length;
  }

  /**
   * Record a freshly-visited location.
   *
   * A move to a NEW location truncates any forward history (standard browser back/forward
   * semantics: navigating after going back discards what was ahead) and appends the location,
   * making it current. Consecutive locations on the SAME line of the SAME document collapse — the
   * tail entry's column is updated in place with no new entry — so tiny cursor drift never spams
   * the stack. The list is capped at MAXIMUM_ENTRY_COUNT, dropping the oldest entries.
   */
  record(location: Location): void {
    const current = this.currentEntry;
    if (
      current &&
      current.documentPath === location.documentPath &&
      current.line === location.line
    ) {
      // Same document + same line: a no-op or tiny drift. Update the tail's column in place; an
      // exact duplicate changes nothing and returns without touching the reactive list.
      if (current.column === location.column) return;
      const collapsedEntries = this.entries.value.slice();
      collapsedEntries[this.currentIndex.value] = location;
      this.entries.value = collapsedEntries;
      return;
    }
    // A genuinely new location: drop any forward history, then append and make it current.
    const retainedEntries = this.entries.value.slice(0, this.currentIndex.value + 1);
    retainedEntries.push(location);
    while (retainedEntries.length > MAXIMUM_ENTRY_COUNT) retainedEntries.shift();
    this.entries.value = retainedEntries;
    this.currentIndex.value = retainedEntries.length - 1;
  }

  /** Step BACK one location and return it, or null when already at the oldest entry. */
  back(): Location | null {
    if (this.currentIndex.value <= 0) return null;
    this.currentIndex.value -= 1;
    return this.entries.value[this.currentIndex.value] ?? null;
  }

  /** Step FORWARD one location and return it, or null when already at the newest entry. */
  forward(): Location | null {
    if (this.currentIndex.value >= this.entries.value.length - 1) return null;
    this.currentIndex.value += 1;
    return this.entries.value[this.currentIndex.value] ?? null;
  }

  /** Drop all recorded history back to the empty state. */
  clear(): void {
    this.entries.value = [];
    this.currentIndex.value = -1;
  }
}

export namespace NavigationHistory {
  export const $Class = $NavigationHistory;
  export let Class = Reactive($Class);
  export type Model = InstanceType<typeof Class>;
  export type Instance = typeof Class.Instance;
}
