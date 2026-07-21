// A workspace: one project root with its file tree, an editor, and which pane has focus.
// (Multi-workspace tabs + per-workspace snapshot restoration are layered on in M2 via
// WorkspaceManager; this is the single-workspace core.)
//
// invariant: Workspace and file navigation are separate layers (workspace.invariants.md)
import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';
import { FileTree } from './FileTree';
import { Editor } from '../editor/Editor';
import { Files } from '../system/Files';
import { GitRepository } from '../git/GitRepository';
import { CommitLog } from '../git/CommitLog';
import { GitPanel } from './GitPanel';
import { addImpulse, stepMomentum, isMoving, AT_REST } from '../ui/scroll-momentum';

export type Focus = 'files' | 'editor' | 'git';

class $Workspace {
  root = '';
  // invariant: Construction goes through overridable seams (project.invariants.md)
  tree = this.createTree();
  editor = this.createEditor();
  gitPanel = this.createGitPanel();

  protected createTree() { return new FileTree.Class(); }
  protected createEditor() { return new Editor.Class(); }
  protected createGitPanel() { return new GitPanel.Class(); }
  // Git repository + commit log need the root, so they are created in open() (not field-init).
  protected createGit(root: string) { return new GitRepository.Class(root); }
  protected createCommitLog(root: string) { return new CommitLog.Class(root); }

  get focus() {
    return ref<Focus>('files');
  }
  get name() {
    return ref('');
  }
  // The repository + commit-log window for the current root (null until open()).
  get git() {
    return shallowRef<GitRepository.Instance | null>(null);
  }
  get commitLog() {
    return shallowRef<CommitLog.Instance | null>(null);
  }

  open(root: string): void {
    this.root = root;
    this.name.value = Files.Class.basename(root) || root;
    this.tree.open(root);
    this.focus.value = 'files';
    // Live-wire git: create the repository + log for this root and kick a non-blocking refresh.
    this.git.value = this.createGit(root);
    this.commitLog.value = this.createCommitLog(root);
    this.gitPanel.back();
    this.gitPanel.back();
    void this.git.value.refresh();
  }

  toggleFocus(): void {
    this.focus.value = this.focus.value === 'files' ? 'editor' : 'files';
  }

  focusEditor(): void {
    this.focus.value = 'editor';
  }
  focusFiles(): void {
    this.focus.value = 'files';
  }
  focusGit(): void {
    this.focus.value = 'git';
  }
  /** Cycle the sidebar between the files tree and the git panel (Ctrl+G style toggle). */
  toggleGit(): void {
    this.focus.value = this.focus.value === 'git' ? 'files' : 'git';
  }

  // invariant: Cost tracks the actively observed set (project.invariants.md)
  /**
   * Scroll the commit-log WINDOW by `delta` rows (mouse wheel / paging). Moves `logScrollTop` only
   * (not the selection), clamps to `[0, knownEnd)`, and asks the CommitLog to ensure the new window
   * is loaded — the sparse cache fetches the entered pages and evicts the exited ones, so scrolling
   * a huge log never materializes more than the observed window.
   */
  scrollGitLog(delta: number): void {
    const gp = this.gitPanel;
    const cl = this.commitLog.value;
    const end = cl?.knownEnd.value ?? Number.POSITIVE_INFINITY;
    const cap = Number.isFinite(end) ? Math.max(0, (end as number) - 1) : gp.logScrollTop.value + Math.max(0, delta);
    gp.logScrollTop.value = Math.max(0, Math.min(gp.logScrollTop.value + delta, cap));
    void cl?.ensureRange(gp.logScrollTop.value, 50);
  }

  /** A wheel notch: add a momentum impulse (the frame loop then glides the log). */
  impulseGitLog(deltaRows: number): void {
    this.gitPanel.logMomentum.value = addImpulse(this.gitPanel.logMomentum.value, deltaRows);
  }

  /** Halt the log glide immediately (keyboard paging / a jump — One-Writer-Per-Regime). */
  haltGitLogScroll(): void {
    this.gitPanel.logMomentum.value = AT_REST;
  }

  // invariant: One writer per scroll regime per frame (src/modules/ui/ui.invariants.md)
  /**
   * Advance the commit-log glide by one frame of `dtSec`. Steps the momentum, moves the window by
   * the resulting whole rows (clamped, pages fetched/evicted), and returns whether it is still
   * moving (the frame loop keeps requesting frames while true). Cost stays O(window).
   */
  tickGitLogScroll(dtSec: number): boolean {
    const gp = this.gitPanel;
    const { momentum, rows } = stepMomentum(gp.logMomentum.value, dtSec);
    gp.logMomentum.value = momentum;
    if (rows !== 0) this.scrollGitLog(rows);
    return isMoving(momentum);
  }

  /** Activate the current tree selection: open a file (and focus editor) or toggle a dir. */
  activate(): { opened?: string } {
    const res = this.tree.activateSelected();
    if (res && 'openFile' in res) {
      this.editor.openFile(res.openFile);
      this.focus.value = 'editor';
      return { opened: res.openFile };
    }
    return {};
  }
}

export namespace Workspace {
  export const $Class = $Workspace;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
