// Reactive VIEW state for the git sidebar — which view is showing, the selection/scroll within it,
// and the split between the changes/commit-box region and the commit-log region. Pure view state:
// the git DATA lives in GitRepository (status) and CommitLog (history). Drill-down is a small stack:
// changes → a commit's files → a file's diff, with `back()` unwinding it.
import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';
import { AT_REST, type ScrollMomentum } from '../ui/Momentum';

/** Which region of the git panel has keyboard focus. */
export type GitRegion = 'changes' | 'commit' | 'log';

const MIN_SPLIT = 0.15;
const MAX_SPLIT = 0.85;

class $GitPanel {
  get region() {
    return ref<GitRegion>('changes');
  }
  get changesIndex() {
    return ref(0);
  }
  get logIndex() {
    return ref(0);
  }
  get logScrollTop() {
    return ref(0);
  }
  // Changes-list window + hover state (hover is highlight-only, never selection truth).
  get changesScrollTop() {
    return ref(0);
  }
  get changesScrollLeft() {
    return ref(0);
  }
  get changesViewportWidth() {
    return ref(1);
  }
  get changesContentWidth() {
    return ref(0);
  }
  get changesMomentum() {
    return shallowRef<ScrollMomentum>(AT_REST);
  }
  get changesHorizontalMomentum() {
    return shallowRef<ScrollMomentum>(AT_REST);
  }
  get changesHovered() {
    return ref(-1);
  }
  get logHovered() {
    return ref(-1);
  }
  // Pending destructive confirmation (discard) — rendered as a y/N overlay; null = none.
  // paths: one or many (collective discard lists them all).
  get confirmDiscard() {
    return shallowRef<{ paths: string[]; buckets: Map<string, 'staged' | 'unstaged' | 'untracked'> } | null>(null);
  }

  // MULTI-SELECTION of change files, keyed by PATH (survives rows reshuffling between sections
  // as staging moves them). Identity-replaced on change so observers re-run.
  get selectedPaths() {
    return shallowRef<ReadonlySet<string>>(new Set());
  }

  toggleSelected(path: string): void {
    const next = new Set(this.selectedPaths.value);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    this.selectedPaths.value = next;
  }

  selectMany(paths: string[]): void {
    this.selectedPaths.value = new Set([...this.selectedPaths.value, ...paths]);
  }

  /** Replace the whole selection (right-click on an unselected row; Shift+click range). */
  replaceSelected(paths: string[]): void {
    this.selectedPaths.value = new Set(paths);
  }

  clearSelectedPaths(): void {
    if (this.selectedPaths.value.size > 0) this.selectedPaths.value = new Set();
  }
  // Momentum state for the commit-log wheel glide (see ui/scroll-momentum).
  get logMomentum() {
    return shallowRef<ScrollMomentum>(AT_REST);
  }
  get logScrollLeft() {
    return ref(0);
  }
  get logViewportWidth() {
    return ref(1);
  }
  get logContentWidth() {
    return ref(0);
  }
  get logHorizontalMomentum() {
    return shallowRef<ScrollMomentum>(AT_REST);
  }
  /** Fraction of the sidebar height given to the top (changes+commit) region. */
  get splitRatio() {
    return ref(0.5);
  }
  get commitMessage() {
    return ref('');
  }

  /** Clamp and set the top/bottom split ratio (from a divider drag). */
  setSplit(ratio: number): void {
    this.splitRatio.value = Math.max(MIN_SPLIT, Math.min(MAX_SPLIT, ratio));
  }

  // invariant: A pane is a self-contained scrollable viewport (project.invariants.md)
  get changesMaxScrollLeft(): number {
    return Math.max(0, this.changesContentWidth.value - Math.max(1, this.changesViewportWidth.value));
  }

  get logMaxScrollLeft(): number {
    return Math.max(0, this.logContentWidth.value - Math.max(1, this.logViewportWidth.value));
  }

  setChangesHorizontalExtent(contentWidth: number, viewportWidth: number): void {
    this.changesContentWidth.value = Math.max(0, contentWidth);
    this.changesViewportWidth.value = Math.max(1, viewportWidth);
    this.changesScrollLeft.value = Math.max(
      0,
      Math.min(this.changesScrollLeft.value, this.changesMaxScrollLeft),
    );
  }

  setLogHorizontalExtent(contentWidth: number, viewportWidth: number): void {
    this.logContentWidth.value = Math.max(0, contentWidth);
    this.logViewportWidth.value = Math.max(1, viewportWidth);
    this.logScrollLeft.value = Math.max(0, Math.min(this.logScrollLeft.value, this.logMaxScrollLeft));
  }

  scrollChangesByColumns(deltaColumns: number): void {
    this.changesScrollLeft.value = Math.max(
      0,
      Math.min(this.changesScrollLeft.value + deltaColumns, this.changesMaxScrollLeft),
    );
  }

  scrollLogByColumns(deltaColumns: number): void {
    this.logScrollLeft.value = Math.max(
      0,
      Math.min(this.logScrollLeft.value + deltaColumns, this.logMaxScrollLeft),
    );
  }

}

export namespace GitPanel {
  export const $Class = $GitPanel;
  export let Class = Reactive($Class);
  export type Model = InstanceType<typeof Class>;
  export type Instance = typeof Class.Instance;
}
