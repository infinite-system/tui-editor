// Reactive VIEW state for the git sidebar — which view is showing, the selection/scroll within it,
// and the split between the changes/commit-box region and the commit-log region. Pure view state:
// the git DATA lives in GitRepository (status) and CommitLog (history). Drill-down is a small stack:
// changes → a commit's files → a file's diff, with `back()` unwinding it.
import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';

export type GitView = 'changes' | 'commitFiles' | 'fileDiff';
/** Which region of the top "changes" view has keyboard focus. */
export type GitRegion = 'changes' | 'commit' | 'log';

export interface CommitFileEntry {
  path: string;
  status: string; // porcelain letter: M/A/D/R/…
}

const MIN_SPLIT = 0.15;
const MAX_SPLIT = 0.85;

class $GitPanel {
  get view() {
    return ref<GitView>('changes');
  }
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
  /** Fraction of the sidebar height given to the top (changes+commit) region. */
  get splitRatio() {
    return ref(0.5);
  }
  get commitMessage() {
    return ref('');
  }
  // Drill-down state.
  get activeCommit() {
    return shallowRef<string | null>(null);
  }
  get commitFiles() {
    return shallowRef<CommitFileEntry[]>([]);
  }
  get commitFilesIndex() {
    return ref(0);
  }
  get activeFile() {
    return shallowRef<string | null>(null);
  }

  /** Clamp and set the top/bottom split ratio (from a divider drag). */
  setSplit(ratio: number): void {
    this.splitRatio.value = Math.max(MIN_SPLIT, Math.min(MAX_SPLIT, ratio));
  }

  /** Drill into a commit: show its changed files. */
  openCommit(sha: string, files: CommitFileEntry[]): void {
    this.activeCommit.value = sha;
    this.commitFiles.value = files;
    this.commitFilesIndex.value = 0;
    this.view.value = 'commitFiles';
  }

  /** Drill into a file of the active commit: show its diff. */
  openFile(path: string): void {
    this.activeFile.value = path;
    this.view.value = 'fileDiff';
  }

  /** Unwind one drill-down level: fileDiff → commitFiles → changes. */
  back(): void {
    if (this.view.value === 'fileDiff') {
      this.activeFile.value = null;
      this.view.value = 'commitFiles';
    } else if (this.view.value === 'commitFiles') {
      this.activeCommit.value = null;
      this.commitFiles.value = [];
      this.view.value = 'changes';
    }
  }
}

export namespace GitPanel {
  export const $Class = $GitPanel;
  export let Class = Reactive($Class);
  export type Model = InstanceType<typeof Class>;
  export type Instance = typeof Class.Instance;
}
