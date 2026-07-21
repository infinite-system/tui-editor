// A workspace: one project root with its file tree, an editor, and which pane has focus.
// (Multi-workspace tabs + per-workspace snapshot restoration are layered on in M2 via
// WorkspaceManager; this is the single-workspace core.)
//
// invariant: Workspace and file navigation are separate layers (workspace.invariants.md)
import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';
import { FileTree } from './FileTree';
import { Editor } from '../editor/Editor';
import { OpenBufferSet } from './OpenBufferSet';
import { Files } from '../system/Files';
import { GitRepository } from '../git/GitRepository';
import { GitWatcher } from '../git/GitWatcher';
import { CommitLog } from '../git/CommitLog';
import { CommitExpansion } from '../git/CommitExpansion';
import { GitPanel } from './GitPanel';
import { addImpulse, stepMomentum, isMoving, halt, VERTICAL_MOMENTUM, type MomentumOptions } from '../ui/scroll-momentum';
import type { Settings } from '../settings/Settings';
import { GitRows } from '../git/GitRows';
import { GitLogRows, type CommitLogRow } from '../git/GitLogRows';
import { GitCommands } from '../git/GitCommands';
import { lineWidth } from '../editor/editor.coordinates';
import { Logging } from '../system/Logging';

export type Focus = 'files' | 'editor' | 'git';

class $Workspace {
  root = '';
  // invariant: Construction goes through overridable seams (project.invariants.md)
  tree = this.createTree();
  // The set of open editor buffers behind the tab bar (item 10a): opening a file ADDS or FOCUSES a
  // tab, never replaces. Flyweight — only the active buffer (and any dirty background buffer) holds a
  // live document; clean background tabs dehydrate to a light handle and rehydrate on activation.
  buffers = this.createBufferSet();
  gitPanel = this.createGitPanel();
  // A persistent, REUSED editor for read-only git diffs (drill-down). A diff is transient and does
  // NOT become a file tab (editable side-by-side diff is item 14), so it never clobbers a tab.
  protected diffEditor = this.createEditor();
  // The empty-state editor shown when no tab is open (hasDocument stays false).
  protected emptyEditor = this.createEditor();

  protected createTree() { return new FileTree.Class(); }
  protected createEditor() {
    const editor = new Editor.Class();
    // Word wrap is global: every editor reads the SAME settings.wordWrap when settings are attached, so
    // the mode is consistent across tabs + the diff/empty editors. Editors made before attachSettings
    // (diffEditor/emptyEditor) are retro-attached there.
    if (this.settingsSource) editor.attachWordWrap(this.settingsSource.wordWrap);
    return editor;
  }
  protected createGitPanel() { return new GitPanel.Class(); }
  protected createBufferSet() {
    return new OpenBufferSet.Class({
      // The set only ever holds Editors (this seam is the sole creator), so `editor` below can treat
      // activeBuffer as an Editor.
      createBuffer: (path) => {
        const editor = this.createEditor();
        editor.openFile(path);
        return editor;
      },
      disposeBuffer: (buffer) => (buffer as Editor.Instance).dispose(),
    });
  }

  /** True while a read-only git diff is displayed in the editor pane (over the tabs). */
  get showingDiff() {
    return ref(false);
  }

  /** The editor currently VISIBLE in the pane — a git diff while drilling, else the active tab's
   *  buffer, else the empty-state editor. All movement/render/edit target this one. */
  get editor(): Editor.Instance {
    if (this.showingDiff.value) return this.diffEditor;
    // Safe cast: createBufferSet's seam is the only buffer creator and always makes an Editor.
    return (this.buffers.activeBuffer as Editor.Instance | null) ?? this.emptyEditor;
  }
  // Git repository + commit log need the root, so they are created in open() (not field-init).
  protected createGit(root: string) { return new GitRepository.Class(root); }
  protected createCommitLog(root: string) { return new CommitLog.Class(root); }
  // Watches the working tree so EXTERNAL changes (editor saves elsewhere, other processes, branch
  // switches, on-disk edits) live-refresh the git panel + tree decorations — not just our own actions.
  protected createGitWatcher(root: string, repository: GitRepository.Instance) {
    return new GitWatcher.Class(root, repository);
  }
  private gitWatcher: GitWatcher.Model | null = null;

  // Optional live settings source: when attached, the vertical scroll-momentum profile reads its
  // ceiling / gain / friction from the reactive Settings store so the settings panel LIVE-APPLIES
  // (no restart). Unattached (tests) falls back to the tuned VERTICAL_MOMENTUM default.
  private settingsSource: Settings.Instance | null = null;
  attachSettings(settings: Settings.Instance): void {
    this.settingsSource = settings;
    // Retro-attach the global wordWrap source to editors already built (field-init diff/empty editors +
    // any live buffers from session restore). Future editors get it in createEditor.
    this.diffEditor.attachWordWrap(settings.wordWrap);
    this.emptyEditor.attachWordWrap(settings.wordWrap);
    for (const entry of this.buffers.entries.value) {
      (entry.buffer as Editor.Instance | null)?.attachWordWrap(settings.wordWrap);
    }
  }
  private get verticalMomentum(): MomentumOptions {
    const settings = this.settingsSource;
    if (!settings) return VERTICAL_MOMENTUM;
    return {
      impulse: settings.scrollAccelGain.value,
      max: settings.verticalFlingCeiling.value,
      decayPerSec: settings.scrollFriction.value,
      stopVelocity: VERTICAL_MOMENTUM.stopVelocity,
    };
  }
  // SINGLE SOURCE of the git changes/log split: settings.gitSplitRatio when settings are attached
  // (so the panel control + the draggable divider + persistence all agree), else the panel-local
  // ratio (unit tests, no-settings). Every reader — the renderer AND the scroll geometry here — must
  // read THIS, never gitPanel.splitRatio directly, or the two diverge.
  get gitSplitRatio(): number {
    const settings = this.settingsSource;
    return settings ? settings.gitSplitRatio.value : this.gitPanel.splitRatio.value;
  }
  // Clamp + write the split LIVE (a divider drag tick). Updates the reactive settings.gitSplitRatio in
  // memory so the split moves smoothly; the panel-local ratio stays mirrored. Does NOT persist — save()
  // is a synchronous disk write and must never run at mouse-move frequency (frame stall). Call
  // persistGitSplit() ONCE on drag end.
  setGitSplit(ratio: number): void {
    const clamped = Math.max(0.15, Math.min(0.85, ratio));
    this.gitPanel.setSplit(clamped);
    if (this.settingsSource) this.settingsSource.gitSplitRatio.value = clamped;
  }
  /** Persist the split once, on drag release (never per tick). */
  persistGitSplit(): void {
    this.settingsSource?.save();
  }
  protected createCommitExpansion(root: string) { return new CommitExpansion.Class(root); }

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
  get commitExpansion() {
    return shallowRef<CommitExpansion.Instance | null>(null);
  }

  open(root: string): void {
    this.root = root;
    this.name.value = Files.Class.basename(root) || root;
    this.tree.open(root);
    this.focus.value = 'files';
    // Live-wire git: create the repository + log for this root and kick a non-blocking refresh.
    this.git.value = this.createGit(root);
    this.commitLog.value = this.createCommitLog(root);
    this.commitExpansion.value = this.createCommitExpansion(root);
    void this.git.value.refresh();
    // Watch the working tree so external changes refresh the panel WITHOUT any in-app action.
    this.gitWatcher?.dispose();
    this.gitWatcher = this.createGitWatcher(root, this.git.value);
  }

  /** Tear down owned resources with effects/handles (the working-tree watcher + open buffers). */
  dispose(): void {
    this.gitWatcher?.dispose();
    this.gitWatcher = null;
    this.buffers.disposeAll();
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
    const end = this.logFlatEnd();
    const maxScrollTop = Number.isFinite(end) ? Math.max(0, end - 1) : gitPanel.logScrollTop.value + Math.max(0, delta);
    gitPanel.logScrollTop.value = Math.max(0, Math.min(gitPanel.logScrollTop.value + delta, maxScrollTop));
    this.ensureLogWindow(gitPanel.logScrollTop.value);
  }

  // --- commit-log flat rows (inline commit expansion) ------------------------------------------
  // The log region scrolls/selects over FLAT rows: a collapsed commit is 1 row; an expanded one is
  // 1 + fileCount (or 1 + a loading row while its lazy fetch is in flight). The pure model lives in
  // git.log-rows.ts and is shared with the renderer/hit-tester.
  // invariant: Commit expansion is lazy and windowed (src/modules/git/git.invariants.md)

  private expandedEntries() {
    return this.commitExpansion.value?.entries.value ?? [];
  }

  /** One past the last flat log row (Infinity until the end of history is discovered). */
  logFlatEnd(): number {
    const end = this.commitLog.value?.knownEnd.value ?? Number.POSITIVE_INFINITY;
    return GitLogRows.Class.totalFlatRows(this.expandedEntries(), end);
  }

  /** The flat log row at `flatIndex` (commit header / commit file / loading), or null. O(window). */
  logRowAt(flatIndex: number): CommitLogRow | null {
    const commitLog = this.commitLog.value;
    if (!commitLog || flatIndex < 0) return null;
    const rows = GitLogRows.Class.commitLogRows(
      flatIndex,
      1,
      this.expandedEntries(),
      (commitIndex) => commitLog.rows(commitIndex, 1)[0],
      commitLog.knownEnd.value,
    );
    return rows[0] ?? null;
  }

  /** Ensure the COMMIT pages behind the flat window `[flatTop, flatTop+count)` are loaded —
   *  expansion only shrinks how many commits a window shows, so `count` commits always cover it. */
  ensureLogWindow(flatTop: number, count = 50): void {
    const commitLog = this.commitLog.value;
    if (!commitLog) return;
    const firstCommitIndex = GitLogRows.Class.commitIndexAtFlatRow(this.expandedEntries(), Math.max(0, flatTop));
    void commitLog.ensureRange(firstCommitIndex, count);
  }

  /** Enter/click on a flat log row: a commit header toggles its LAZY expansion (fetch on demand,
   *  loading row until it lands); a file row opens that file's diff for that commit. */
  activateLogRow(flatIndex: number): void {
    const row = this.logRowAt(flatIndex);
    const expansion = this.commitExpansion.value;
    if (!row || !expansion) return;
    if (row.kind === 'commit') {
      if (row.record) expansion.toggle(row.commitIndex, row.record.sha);
    } else if (row.kind === 'commitFile') {
      void this.openCommitFileDiff(row.sha, row.path);
    }
  }

  /** Left on a flat log row: collapse the expanded commit (from its header OR any of its file
   *  rows), keeping the selection on the commit's header row. */
  collapseLogRow(flatIndex: number): void {
    const row = this.logRowAt(flatIndex);
    const expansion = this.commitExpansion.value;
    if (!row || !expansion) return;
    const sha = row.kind === 'commit' ? row.record?.sha : row.sha;
    if (!sha || !expansion.isExpanded(sha)) return;
    expansion.collapse(sha);
    const headerFlatIndex = GitLogRows.Class.commitFlatIndex(expansion.entries.value, row.commitIndex);
    this.gitPanel.logIndex.value = headerFlatIndex;
    if (this.gitPanel.logScrollTop.value > headerFlatIndex) {
      this.gitPanel.logScrollTop.value = headerFlatIndex;
    }
  }

  /** Open ONE file's diff as of ONE commit: `git diff <sha>^ <sha> -- <path>` (a root commit has
   *  no parent — fall back to the commit's own patch). Read-only diff document in the editor; the
   *  sidebar stays on the git panel (mirrors openChangeAtRow). */
  async openCommitFileDiff(sha: string, filePath: string): Promise<void> {
    let result = await GitCommands.Class.diffCommitFile(this.root, sha, filePath);
    if (result.code !== 0) result = await GitCommands.Class.showCommitFile(this.root, sha, filePath);
    const diffText = result.stdout.trimEnd() || '(no differences)';
    this.diffEditor.openDiff(`${filePath} @ ${sha.slice(0, 7)}`, diffText);
    this.showingDiff.value = true; // the pane shows the diff OVER the tabs (transient view)
    this.focus.value = 'editor'; // keyboard to the diff; sidebarView stays 'git'
  }

  /** A wheel notch: add a momentum impulse (the frame loop then glides the log). VERTICAL regimes use
   *  the higher-ceiling profile (item E) so a hard fling covers ground fast; horizontal stays default. */
  impulseGitLog(deltaRows: number): void {
    this.gitPanel.logMomentum.value = addImpulse(this.gitPanel.logMomentum.value, deltaRows, this.verticalMomentum);
  }

  impulseEditorVerticalScroll(deltaRows: number): void {
    const viewport = this.editor.viewport;
    viewport.verticalScrollMomentum.value = addImpulse(viewport.verticalScrollMomentum.value, deltaRows, this.verticalMomentum);
  }

  impulseEditorHorizontalScroll(deltaColumns: number): void {
    const viewport = this.editor.viewport;
    viewport.horizontalScrollMomentum.value = addImpulse(viewport.horizontalScrollMomentum.value, deltaColumns);
  }

  impulseTreeScroll(deltaRows: number): void {
    this.tree.selectionMomentum.value = addImpulse(this.tree.selectionMomentum.value, deltaRows, this.verticalMomentum);
  }

  impulseGitChangesScroll(deltaRows: number): void {
    this.gitPanel.changesMomentum.value = addImpulse(this.gitPanel.changesMomentum.value, deltaRows, this.verticalMomentum);
  }

  /** Halt the log glide immediately (keyboard paging / a jump — One-Writer-Per-Regime). */
  haltGitLogScroll(): void {
    this.gitPanel.logMomentum.value = halt();
  }

  haltTreeScroll(): void {
    this.tree.selectionMomentum.value = halt();
  }

  haltGitChangesScroll(): void {
    this.gitPanel.changesMomentum.value = halt();
  }

  /**
   * Stage/unstage the FILE row at `rowIndex` of the changes row model (headers no-op):
   * staged → unstage; unstaged/untracked → stage. Refreshes status after.
   */
  async toggleStageAtRow(rowIndex: number): Promise<void> {
    const git = this.git.value;
    if (!git) return;
    const rows = GitRows.Class.buildChangeRows(git.staged.value, git.unstaged.value, git.untracked.value);
    const row = rows[rowIndex];
    if (row?.kind !== 'file') return;
    if (row.bucket === 'staged') await git.unstage([row.path]);
    else await git.stage([row.path]);
    await git.refresh();
  }

  // invariant: One writer per scroll regime per frame (src/modules/ui/ui.invariants.md)
  /** Advance every wheel glide by one frame and report whether another frame is required. */
  tickScrollAnimations(dtSeconds: number): boolean {
    const gitPanel = this.gitPanel;
    const editorViewport = this.editor.viewport;

    // Vertical regimes step with the higher-ceiling profile (item E); horizontal keeps the default.
    const gitLogStep = stepMomentum(gitPanel.logMomentum.value, dtSeconds, this.verticalMomentum);
    gitPanel.logMomentum.value = gitLogStep.momentum;
    if (gitLogStep.rows !== 0) this.scrollGitLog(gitLogStep.rows);

    const editorVerticalStep = stepMomentum(editorViewport.verticalScrollMomentum.value, dtSeconds, this.verticalMomentum);
    editorViewport.verticalScrollMomentum.value = editorVerticalStep.momentum;
    if (editorVerticalStep.rows !== 0) {
      editorViewport.scrollBy(editorVerticalStep.rows, this.editor.document.lineCount);
    }

    const editorHorizontalStep = stepMomentum(editorViewport.horizontalScrollMomentum.value, dtSeconds);
    editorViewport.horizontalScrollMomentum.value = editorHorizontalStep.momentum;
    if (editorHorizontalStep.rows !== 0) {
      let widestVisibleLineWidth = 0;
      for (const line of this.editor.document.slice(editorViewport.scrollTop.value, editorViewport.height.value)) {
        widestVisibleLineWidth = Math.max(widestVisibleLineWidth, lineWidth(line));
      }
      editorViewport.scrollByColumns(editorHorizontalStep.rows, widestVisibleLineWidth);
    }

    const treeStep = stepMomentum(this.tree.selectionMomentum.value, dtSeconds, this.verticalMomentum);
    this.tree.selectionMomentum.value = treeStep.momentum;
    // Wheel scrolls the tree WINDOW (independent offset), not the selection — so the list scrolls as
    // one uniform surface and the selection highlight travels with its row (git-changes behaviour).
    if (treeStep.rows !== 0) this.tree.scrollBy(treeStep.rows);

    const changesStep = stepMomentum(gitPanel.changesMomentum.value, dtSeconds, this.verticalMomentum);
    gitPanel.changesMomentum.value = changesStep.momentum;
    if (changesStep.rows !== 0) {
      const git = this.git.value;
      const changeRows = git ? GitRows.Class.buildChangeRows(git.staged.value, git.unstaged.value, git.untracked.value) : [];
      const changesRegionHeight = Math.max(
        1,
        Math.max(2, Math.floor(editorViewport.height.value * this.gitSplitRatio)) - 1,
      );
      const maximumChangesScrollTop = Math.max(0, changeRows.length - changesRegionHeight);
      gitPanel.changesScrollTop.value = Math.max(
        0,
        Math.min(gitPanel.changesScrollTop.value + changesStep.rows, maximumChangesScrollTop),
      );
    }

    return [
      gitLogStep.momentum,
      editorVerticalStep.momentum,
      editorHorizontalStep.momentum,
      treeStep.momentum,
      changesStep.momentum,
    ].some(isMoving);
  }

  /** Open the DIFF of the file at a changes-row (row click / 'o'): the git panel STAYS in the
   *  sidebar, the editor shows the change vs its previous state, read-only, diff-colored. */
  async openChangeAtRow(rowIndex: number): Promise<void> {
    const git = this.git.value;
    if (!git) return;
    const rows = GitRows.Class.buildChangeRows(git.staged.value, git.unstaged.value, git.untracked.value);
    const row = rows[rowIndex];
    if (row?.kind !== 'file') return;
    const result = await GitCommands.Class.diffFile(this.root, row.path, row.bucket);
    const diffText = result.stdout.trimEnd() || '(no differences)';
    this.diffEditor.openDiff(row.path, diffText);
    this.showingDiff.value = true; // the pane shows the diff OVER the tabs (transient view)
    this.focus.value = 'editor'; // keyboard to the diff; sidebarView stays 'git'
  }

  /** Request a discard — DESTRUCTIVE, so it only arms the confirmation overlay (y confirms).
   *  invariant: Destructive working-tree operations require confirmation (src/modules/git/git.invariants.md) */
  requestDiscardAtRow(rowIndex: number): void {
    const git = this.git.value;
    if (!git) return;
    const rows = GitRows.Class.buildChangeRows(git.staged.value, git.unstaged.value, git.untracked.value);
    const row = rows[rowIndex];
    if (row?.kind !== 'file') return;
    this.gitPanel.confirmDiscard.value = { paths: [row.path], buckets: new Map([[row.path, row.bucket]]) };
  }

  /** The file rows for the current multi-selection (empty when none). */
  private selectedFileRows(): Array<{ path: string; bucket: 'staged' | 'unstaged' | 'untracked' }> {
    const git = this.git.value;
    if (!git) return [];
    const selected = this.gitPanel.selectedPaths.value;
    const rows = GitRows.Class.buildChangeRows(git.staged.value, git.unstaged.value, git.untracked.value);
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

  /** Activate the current tree selection: open a file (adds/focuses a tab) or toggle a dir. */
  activate(): { opened?: string } {
    this.haltTreeScroll();
    const result = this.tree.activateSelected();
    if (result && 'openFile' in result) {
      this.openFileInTab(result.openFile);
      this.focus.value = 'editor';
      return { opened: result.openFile };
    }
    return {};
  }

  // --- editor buffer tabs (item 10a) ---------------------------------------
  // Opening a file ADDS or FOCUSES a tab (never replaces). The buffer set owns the flyweight/dispose
  // discipline; Workspace just leaves diff view and keeps the active buffer's dirty flag fresh.

  /** Open `path` as a tab: focus its tab if already open, else add a new active one. */
  openFileInTab(path: string): void {
    this.showingDiff.value = false; // a real file replaces the transient diff view
    this.buffers.open(path);
  }

  /** Activate an already-open tab by index (tab click / cycle). */
  activateTab(index: number): void {
    this.showingDiff.value = false;
    this.buffers.activate(index);
    this.focus.value = 'editor';
  }

  /** Cycle tabs by `delta`, wrapping (Ctrl+Tab / Ctrl+PageUp-Down). */
  cycleTab(delta: number): void {
    if (this.buffers.count === 0) return;
    this.showingDiff.value = false;
    this.buffers.cycle(delta);
    this.focus.value = 'editor';
  }

  /** Pending dirty-tab-close confirmation: the tab index awaiting y/N, or -1 when none. */
  get pendingCloseTabIndex() {
    return ref(-1);
  }

  /** Whether closing tab `index` needs a dirty-discard confirmation first. */
  tabNeedsCloseConfirm(index: number): boolean {
    return this.buffers.tabs()[index]?.dirty ?? false;
  }

  /** Close tab `index`, fully disposing its buffer (document/undo/syntax). Clean-close path. */
  closeTab(index: number): void {
    this.buffers.close(index);
    if (this.buffers.count === 0) this.focus.value = 'files';
  }

  /** Close tab `index`, prompting first if it has unsaved edits (dirty → modal confirm). */
  requestCloseTab(index: number): void {
    if (index < 0 || index >= this.buffers.count) return;
    if (this.tabNeedsCloseConfirm(index)) {
      this.pendingCloseTabIndex.value = index;
      return;
    }
    this.closeTab(index);
  }

  /** Close the ACTIVE tab (Ctrl+W), prompting if dirty. */
  closeActiveTab(): void {
    this.requestCloseTab(this.buffers.activeIndex.value);
  }

  /** Confirm the pending dirty-tab close (modal 'y'). */
  confirmCloseTab(): void {
    const index = this.pendingCloseTabIndex.value;
    this.pendingCloseTabIndex.value = -1;
    if (index >= 0) this.closeTab(index);
  }

  /** Cancel the pending dirty-tab close (modal anything-but-'y'). */
  cancelCloseTab(): void {
    this.pendingCloseTabIndex.value = -1;
  }
}

export namespace Workspace {
  export const $Class = $Workspace;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
