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
import { buildChangeRows } from '../git/git.rows';
import { GitCommands } from '../git/GitCommands';

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
  // WHICH panel the sidebar shows — decoupled from keyboard focus, so opening a diff from the git
  // panel keeps the panel visible while the editor takes focus (VS Code behavior).
  get sidebarView() {
    return ref<'files' | 'git'>('files');
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
    this.sidebarView.value = 'files';
  }
  focusGit(): void {
    this.focus.value = 'git';
  }
  /** Cycle the sidebar between the files tree and the git panel (Ctrl+G style toggle). */
  toggleGit(): void {
    const entering = this.focus.value !== 'git';
    this.focus.value = entering ? 'git' : 'files';
    this.sidebarView.value = entering ? 'git' : 'files';
  }

  // invariant: Cost tracks the actively observed set (project.invariants.md)
  /**
   * Scroll the commit-log WINDOW by `delta` rows (mouse wheel / paging). Moves `logScrollTop` only
   * (not the selection), clamps to `[0, knownEnd)`, and asks the CommitLog to ensure the new window
   * is loaded — the sparse cache fetches the entered pages and evicts the exited ones, so scrolling
   * a huge log never materializes more than the observed window.
   */
  scrollGitLog(delta: number): void {
    const gitPanel = this.gitPanel;
    const commitLog = this.commitLog.value;
    const end = commitLog?.knownEnd.value ?? Number.POSITIVE_INFINITY;
    const maxScrollTop = Number.isFinite(end) ? Math.max(0, (end as number) - 1) : gitPanel.logScrollTop.value + Math.max(0, delta);
    gitPanel.logScrollTop.value = Math.max(0, Math.min(gitPanel.logScrollTop.value + delta, maxScrollTop));
    void commitLog?.ensureRange(gitPanel.logScrollTop.value, 50);
  }

  /** A wheel notch: add a momentum impulse (the frame loop then glides the log). */
  impulseGitLog(deltaRows: number): void {
    this.gitPanel.logMomentum.value = addImpulse(this.gitPanel.logMomentum.value, deltaRows);
  }

  /** Halt the log glide immediately (keyboard paging / a jump — One-Writer-Per-Regime). */
  haltGitLogScroll(): void {
    this.gitPanel.logMomentum.value = AT_REST;
  }

  /**
   * Stage/unstage the FILE row at `rowIndex` of the changes row model (headers no-op):
   * staged → unstage; unstaged/untracked → stage. Refreshes status after.
   */
  async toggleStageAtRow(rowIndex: number): Promise<void> {
    const git = this.git.value;
    if (!git) return;
    const rows = buildChangeRows(git.staged.value, git.unstaged.value, git.untracked.value);
    const row = rows[rowIndex];
    if (row?.kind !== 'file') return;
    if (row.bucket === 'staged') await git.unstage([row.path]);
    else await git.stage([row.path]);
    await git.refresh();
  }

  // invariant: One writer per scroll regime per frame (src/modules/ui/ui.invariants.md)
  /**
   * Advance the commit-log glide by one frame of `dtSec`. Steps the momentum, moves the window by
   * the resulting whole rows (clamped, pages fetched/evicted), and returns whether it is still
   * moving (the frame loop keeps requesting frames while true). Cost stays O(window).
   */
  tickGitLogScroll(dtSec: number): boolean {
    const gitPanel = this.gitPanel;
    const { momentum, rows } = stepMomentum(gitPanel.logMomentum.value, dtSec);
    gitPanel.logMomentum.value = momentum;
    if (rows !== 0) this.scrollGitLog(rows);
    return isMoving(momentum);
  }

  /** Open the DIFF of the file at a changes-row (row click / 'o'): the git panel STAYS in the
   *  sidebar, the editor shows the change vs its previous state, read-only, diff-colored. */
  async openChangeAtRow(rowIndex: number): Promise<void> {
    const git = this.git.value;
    if (!git) return;
    const rows = buildChangeRows(git.staged.value, git.unstaged.value, git.untracked.value);
    const row = rows[rowIndex];
    if (row?.kind !== 'file') return;
    const result = await GitCommands.Class.diffFile(this.root, row.path, row.bucket);
    const diffText = result.stdout.trimEnd() || '(no differences)';
    this.editor.openDiff(row.path, diffText);
    this.focus.value = 'editor'; // keyboard to the diff; sidebarView stays 'git'
  }

  /** Request a discard — DESTRUCTIVE, so it only arms the confirmation overlay (y confirms).
   *  invariant: Destructive working-tree operations require confirmation (src/modules/git/git.invariants.md) */
  requestDiscardAtRow(rowIndex: number): void {
    const git = this.git.value;
    if (!git) return;
    const rows = buildChangeRows(git.staged.value, git.unstaged.value, git.untracked.value);
    const row = rows[rowIndex];
    if (row?.kind !== 'file') return;
    this.gitPanel.confirmDiscard.value = { paths: [row.path], buckets: new Map([[row.path, row.bucket]]) };
  }

  /** The file rows for the current multi-selection (empty when none). */
  private selectedFileRows(): Array<{ path: string; bucket: 'staged' | 'unstaged' | 'untracked' }> {
    const git = this.git.value;
    if (!git) return [];
    const selected = this.gitPanel.selectedPaths.value;
    const rows = buildChangeRows(git.staged.value, git.unstaged.value, git.untracked.value);
    const out: Array<{ path: string; bucket: 'staged' | 'unstaged' | 'untracked' }> = [];
    for (const row of rows) if (row.kind === 'file' && selected.has(row.path)) out.push(row);
    return out;
  }

  /** Collective actions over the multi-selection (context menu). */
  async stageSelected(): Promise<void> {
    const git = this.git.value;
    const targets = this.selectedFileRows().filter((row) => row.bucket !== 'staged');
    if (!git || targets.length === 0) return;
    await git.stage(targets.map((row) => row.path));
    await git.refresh();
  }

  async unstageSelected(): Promise<void> {
    const git = this.git.value;
    const targets = this.selectedFileRows().filter((row) => row.bucket === 'staged');
    if (!git || targets.length === 0) return;
    await git.unstage(targets.map((row) => row.path));
    await git.refresh();
  }

  /** Arms the y/N confirm listing every selected file (destructive — never immediate). */
  requestDiscardSelected(): void {
    const targets = this.selectedFileRows();
    if (targets.length === 0) return;
    this.gitPanel.confirmDiscard.value = {
      paths: targets.map((row) => row.path),
      buckets: new Map(targets.map((row) => [row.path, row.bucket])),
    };
  }

  async confirmDiscard(): Promise<void> {
    const pending = this.gitPanel.confirmDiscard.value;
    const git = this.git.value;
    this.gitPanel.confirmDiscard.value = null;
    if (!pending || !git) return;
    for (const filePath of pending.paths) {
      const bucket = pending.buckets.get(filePath);
      if (bucket) await GitCommands.Class.discard(this.root, filePath, bucket);
    }
    this.gitPanel.clearSelectedPaths();
    await git.refresh();
  }

  cancelDiscard(): void {
    this.gitPanel.confirmDiscard.value = null;
  }

  /** Activate the current tree selection: open a file (and focus editor) or toggle a dir. */
  activate(): { opened?: string } {
    const result = this.tree.activateSelected();
    if (result && 'openFile' in result) {
      this.editor.openFile(result.openFile);
      this.focus.value = 'editor';
      return { opened: result.openFile };
    }
    return {};
  }
}

export namespace Workspace {
  export const $Class = $Workspace;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
