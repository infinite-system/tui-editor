// A workspace: one project root with its file tree, an editor, and which pane has focus.
// WorkspaceSet layers project tabs and flyweight activation over this per-root core.
//
// invariant: Workspace and file navigation are separate layers (workspace.invariants.md)
import { Reactive } from 'ivue';
import { computed, ref, shallowRef } from 'vue';
import { spawnSync } from 'node:child_process';
import { FileTree } from './FileTree';
import { Editor } from '../editor/Editor';
import { OpenBufferSet } from './OpenBufferSet';
import { NavigationHistory, type Location } from '../navigation/NavigationHistory';
import { Files } from '../system/Files';
import { GitRepository } from '../git/GitRepository';
import { GitWatcher } from '../git/GitWatcher';
import { CommitLog } from '../git/CommitLog';
import { CommitExpansion } from '../git/CommitExpansion';
import { GitPanel } from './GitPanel';
import { Momentum, VERTICAL_MOMENTUM, type MomentumOptions } from '../system/Momentum';
import type { Settings } from '../settings/Settings';
import { GitRows } from '../git/GitRows';
import { GitLogRows, type CommitLogRow } from '../git/GitLogRows';
import { GitCommands } from '../git/GitCommands';
import { EditorCoordinates } from '../editor/EditorCoordinates';
import { EditorWrap } from '../editor/EditorWrap';
import { Logging } from '../system/Logging';
import { GutterDiff, type GutterDiffStatus } from '../diff/GutterDiff';
import {
  LanguageClient,
  type LanguageHover,
  type LanguageLocation,
  type TextDocumentModel,
  type TextPosition,
} from '../lsp/LanguageClient';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';

/** The project name for a root: the basename of the parent of the git COMMON dir — shared by the
 *  main checkout and every linked worktree of the same repository. `--git-common-dir` resolves to
 *  `<checkout>/.git` for the main checkout and to `<project>/.git` for a worktree, so its parent is
 *  the project root in both cases. Returns '' when the root is not a git repository (caller falls
 *  back to the folder name). One synchronous git call, in open() only — never a hot path. */
function projectNameForRoot(absoluteRoot: string): string {
  const result = spawnSync(
    'git',
    ['-C', absoluteRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8', timeout: 2000 },
  );
  if (result.status !== 0) return '';
  const commonDir = result.stdout.trim();
  return commonDir ? Files.Class.basename(Files.Class.dirname(commonDir)) : '';
}

export type Focus = 'files' | 'editor' | 'git';

/** Which panel the activity bar shows in the sidebar for this workspace. 'extensions' is a
 *  placeholder view for now. Persisted per workspace (it is model state on the Workspace). */
export type SidebarView = 'files' | 'git' | 'extensions';

/** One diagnostic's span on a single line: grapheme columns [startColumn, endColumn) and its severity
 *  (1 = error, 2 = warning, 3 = info, 4 = hint). A multi-line diagnostic yields one mark per line. */
export interface DiagnosticLineMark {
  startColumn: number;
  endColumn: number;
  severity: 1 | 2 | 3 | 4;
}

/** A diagnostic surfaced in the hover card: its severity and message text. */
export interface HoverDiagnostic {
  severity: 1 | 2 | 3 | 4;
  message: string;
}

/** The two full-text SIDES of a side-by-side diff shown by the DiffView (token forces a rebuild). */
export interface DiffRequest {
  token: number;
  previousVersionText: string;
  currentVersionText: string;
  previousVersionPath: string;
  currentVersionPath: string;
}

class $Workspace {
  root = '';
  // invariant: Construction goes through overridable seams (project.invariants.md)
  tree = this.createTree();
  // The set of open editor buffers behind the tab bar (item 10a): opening a file ADDS or FOCUSES a
  // tab, never replaces. Flyweight — only the active buffer (and any dirty background buffer) holds a
  // live document; clean background tabs dehydrate to a light handle and rehydrate on activation.
  buffers = this.createBufferSet();
  gitPanel = this.createGitPanel();
  // Browser-style Go Back / Go Forward: every meaningful jump (go-to-definition, opening a file
  // from the tree / quick-open / a hover or Markdown reference) records the location left AND the
  // location arrived at, so Alt+[ / Alt+] can walk the trail. Reactive so the UI can later show
  // enabled/disabled affordances.
  navigationHistory = this.createNavigationHistory();
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
  protected createNavigationHistory() { return new NavigationHistory.Class(); }
  protected createBufferSet() {
    return new OpenBufferSet.Class({
      // The set only ever holds Editors (this seam is the sole creator), so `editor` below can treat
      // activeBuffer as an Editor.
      createBuffer: (path) => {
        const editor = this.createEditor();
        editor.openFile(path);
        // Every live buffer (fresh open AND flyweight rehydration) registers with the language
        // client here — one choke point. Client construction is cheap; the server subprocess
        // starts only for supported files.
        // invariant: LSP activation follows semantic demand (src/modules/lsp/lsp.invariants.md)
        if (editor.hasDocument.value) this.ensureLanguageClient().openDocument(editor.document);
        return editor;
      },
      disposeBuffer: (buffer) => {
        const editor = buffer as Editor.Instance;
        // Mirror of the openDocument above: dehydration/close/disposeAll all release the
        // server-side document through this one seam.
        if (editor.hasDocument.value && editor.document.path) {
          this.languageClientInstance?.closeDocument(editor.document);
        }
        editor.dispose();
      },
    });
  }

  // --- language intelligence (one client per workspace root) --------------------------------
  // The client is created lazily on the first buffer open; the LSP subprocess itself starts only
  // when a SUPPORTED document opens or a semantic request runs (activation follows demand).
  private languageClientInstance: LanguageClient.Model | null = null;
  protected createLanguageClient(): LanguageClient.Model {
    // Late-read the TypeScript-server choice so a settings change (or an attach that lands after this
    // client is created) is honoured when a document activates the server.
    return new LanguageClient.Class({
      rootPath: this.root,
      preferredTypeScriptServer: () => this.settingsSource?.typescriptServer.value ?? 'auto',
      // Late-read the size budget so a file larger than the limit is never attached to the server
      // (which would balloon and crash the app). `0` = no limit; unset settings (bare tests) also
      // read 0 so tests are unaffected.
      fileSizeLimitKb: () => this.settingsSource?.lspFileSizeLimitKb.value ?? 0,
    });
  }
  private ensureLanguageClient(): LanguageClient.Model {
    if (!this.languageClientInstance) this.languageClientInstance = this.createLanguageClient();
    return this.languageClientInstance;
  }

  /** Push the active buffer's current text to the language server (revision-idempotent full-text
   *  didChange). Driven by the document-revision watch in Bootstrap; no-op before any client
   *  exists or while a transient diff is shown. */
  syncActiveDocumentWithLanguageServer(): void {
    if (this.showingDiff.value) return;
    const editor = this.buffers.activeBuffer as Editor.Instance | null;
    if (!editor || !editor.hasDocument.value || !editor.document.path) return;
    this.languageClientInstance?.syncDocument(editor.document);
  }

  /** The active file's language-size suppression notice, or `null` when it is within the LSP size
   *  budget (or no client/document exists). Surfaced in the status bar so a suppressed large file is
   *  never a silent no-op, and published to the observability channel so a driven gate can assert it.
   *
   * invariant: The LSP attaches only to documents within the size budget (src/modules/lsp/lsp.invariants.md)
   */
  languageSizeNotice(): string | null {
    if (this.showingDiff.value) return null;
    const editor = this.buffers.activeBuffer as Editor.Instance | null;
    const client = this.languageClientInstance;
    if (!client || !editor || !editor.hasDocument.value || !editor.document.path) return null;
    void client.sizeSuppressionRevision.value; // reactive: re-evaluate as suppression flips
    return client.sizeSuppressionNotice(editor.document);
  }

  /**
   * VS-Code-style go-to-definition: resolve the symbol at `position` (Ctrl/Cmd+click) or at the
   * cursor (F12) through the language client, then open the target file as a tab and land the
   * cursor on the declaration. Resolves false — never throws — when no definition is available
   * (no document, unsupported file, server missing, or the server finds nothing).
   *
   * invariant: A definition gesture jumps to the declaration (src/modules/lsp/lsp.invariants.md)
   */
  async goToDefinition(position?: TextPosition): Promise<boolean> {
    if (this.showingDiff.value) return false;
    const editor = this.buffers.activeBuffer as Editor.Instance | null;
    if (!editor || !editor.hasDocument.value || !editor.document.path) return false;
    const client = this.ensureLanguageClient();
    if (!client.supportsDocument(editor.document)) return false;
    const requestPosition = position ?? {
      line: editor.cursor.line.value,
      column: editor.cursor.col.value,
    };
    const location = await client.definition(editor.document, requestPosition);
    if (!location) return false;
    const resolvedLocation = await this.rehopThroughImportSpecifier(
      client,
      editor.document,
      location,
    );
    return this.jumpToLocation(resolvedLocation);
  }

  /** The real server resolves a use site to the IMPORT SPECIFIER while the target file is not
   *  open in the server (and to the original declaration when it is — both observed against
   *  typescript-language-server). One re-request from the import specifier reaches the original
   *  declaration, matching VS Code. */
  private async rehopThroughImportSpecifier(
    client: LanguageClient.Model,
    document: TextDocumentModel,
    location: LanguageLocation,
  ): Promise<LanguageLocation> {
    let landedPath: string;
    try {
      landedPath = fileURLToPath(location.uri);
    } catch {
      return location;
    }
    if (landedPath !== resolvePath(document.path)) return location;
    if (!/^\s*import\b/.test(document.line(location.range.start.line))) return location;
    const rehoppedLocation = await client.definition(document, location.range.start);
    if (!rehoppedLocation) return location;
    const rehoppedToSameSpot =
      rehoppedLocation.uri === location.uri &&
      rehoppedLocation.range.start.line === location.range.start.line &&
      rehoppedLocation.range.start.column === location.range.start.column;
    return rehoppedToSameSpot ? location : rehoppedLocation;
  }

  /**
   * VS-Code-style hover: resolve the type/documentation for the symbol at `position` through the
   * language client so the mouse-hover card can show it. Mirrors goToDefinition's guards exactly —
   * resolves null (never throws) when no document, an unsupported file, a missing server, or the
   * server returns nothing. The client applies its own revision-staleness guard on the response.
   *
   * invariant: A hover card reflects the language server type at the pointed symbol (src/modules/ui/ui.invariants.md)
   */
  async hoverAt(position: TextPosition): Promise<LanguageHover | null> {
    if (this.showingDiff.value) return null;
    const editor = this.buffers.activeBuffer as Editor.Instance | null;
    if (!editor || !editor.hasDocument.value || !editor.document.path) return null;
    const client = this.ensureLanguageClient();
    if (!client.supportsDocument(editor.document)) return null;
    return client.hover(editor.document, position);
  }

  /** Diagnostics whose range covers a document position — surfaced in the hover card so an errored
   *  expression (whose hover type is often just `any`) still shows the real error MESSAGE. */
  diagnosticsAt(position: TextPosition): readonly HoverDiagnostic[] {
    const editor = this.buffers.activeBuffer as Editor.Instance | null;
    const client = this.languageClientInstance;
    if (this.showingDiff.value || !client || !editor || !editor.hasDocument.value) return [];
    void client.diagnosticsRevision.value; // reactive: re-query as diagnostics arrive
    const total = client.diagnosticCountFor(editor.document);
    if (total === 0) return [];
    const covering: HoverDiagnostic[] = [];
    for (const diagnostic of client.diagnosticSlice(editor.document, 0, total)) {
      const { start, end } = diagnostic.range;
      const afterStart =
        position.line > start.line || (position.line === start.line && position.column >= start.column);
      const beforeEnd =
        position.line < end.line || (position.line === end.line && position.column <= end.column);
      if (afterStart && beforeEnd) covering.push({ severity: diagnostic.severity, message: diagnostic.message });
    }
    return covering;
  }

  /** Open the located file through the existing tab path and reveal the declaration. */
  private jumpToLocation(location: LanguageLocation): boolean {
    let targetPath: string;
    try {
      targetPath = fileURLToPath(location.uri);
    } catch {
      return false;
    }
    if (!Files.Class.exists(targetPath) || Files.Class.isDir(targetPath)) return false;
    // Record the SOURCE (the symbol under the cursor) before the jump moves us away, open the
    // target WITHOUT the tab-open auto-record (we record the precise declaration landing ourselves,
    // not the fresh-open 0,0), then record the DESTINATION so Forward returns to the declaration.
    this.recordCurrentLocation();
    this.withSuppressedLocationRecording(() => {
      this.openFileInTab(targetPath);
      this.focus.value = 'editor';
      this.editor.placeCursor(location.range.start.line, location.range.start.column);
      this.editor.revealCursor();
    });
    this.recordCurrentLocation();
    return true;
  }

  /** True while a git diff is displayed over the tabs (transient view). */
  get showingDiff() {
    return ref(false);
  }
  /** File paths whose tabs currently show the Markdown source | preview split. A set keeps the mode
   * per tab, so switching away and back does not silently discard the user's view choice. */
  get markdownPreviewPaths() {
    return shallowRef<ReadonlySet<string>>(new Set());
  }

  get activeFileIsMarkdown(): boolean {
    return (
      !this.showingDiff.value &&
      this.editor.hasDocument.value &&
      Files.Class.extname(this.editor.document.path).toLowerCase() === '.md'
    );
  }

  /** The active buffer is a previewable image (a .png for now) — RootView renders it as half-block
   *  cells instead of the binary-file text. Never true during a diff or with no document open. */
  // invariant: An image buffer replaces the code text and leaves other files untouched (src/modules/image/image.invariants.md)
  get activeFileIsImage(): boolean {
    return (
      !this.showingDiff.value &&
      this.editor.hasDocument.value &&
      Files.Class.extname(this.editor.document.path).toLowerCase() === '.png'
    );
  }

  get showingMarkdownPreview(): boolean {
    return this.activeFileIsMarkdown && this.markdownPreviewPaths.value.has(this.editor.document.path);
  }

  toggleMarkdownPreview(): void {
    if (!this.activeFileIsMarkdown) return;
    const path = this.editor.document.path;
    const nextPaths = new Set(this.markdownPreviewPaths.value);
    if (nextPaths.has(path)) nextPaths.delete(path);
    else nextPaths.add(path);
    this.markdownPreviewPaths.value = nextPaths;
    this.focus.value = 'editor';
  }
  // The two SIDES of the currently-shown side-by-side diff (the rich DiffView), or null. Set by
  // openChangeAtRow / openCommitFileDiff, cleared when a real tab replaces it. The token forces the
  // view host to rebuild (DiffView has no re-open — it reconstructs per file).
  get diffRequest() {
    return shallowRef<DiffRequest | null>(null);
  }
  private diffRequestToken = 0;
  // Full text of a file at a git ref ('HEAD', '<sha>', '<sha>^', '' = index) — empty when absent at that
  // ref (added/untracked/root-commit file = the empty diff side).
  private async gitFileText(ref: string, filePath: string): Promise<string> {
    const result = await GitCommands.Class.fileAtRef(this.root, ref, filePath);
    return result.code === 0 ? result.stdout : '';
  }

  // The active file's git HEAD side. Buffer edits never refetch it; the cached blob changes only
  // when the active document changes, a git reconciliation completes, or the file is saved.
  get activeHeadText() {
    return shallowRef('');
  }
  private activeHeadTextRequestToken = 0;

  // DiffAlignment is deliberately cached behind computed(): alignment is document-sized work, while
  // cursor and selection repaints are frequent and must reuse the same map until HEAD/text changes.
  get gutterDiffByLine() {
    return computed<Map<number, GutterDiffStatus>>(() => {
      const editor = this.editor;
      void editor.document.revision.value;
      if (this.showingDiff.value || !editor.hasDocument.value) return new Map();
      return GutterDiff.Class.statusByLine(this.activeHeadText.value, editor.document.text);
    });
  }

  // Language-server diagnostics for the active document, projected to per-line column ranges: the
  // editor renders a severity-coloured gutter mark AND a coloured underline over each range. Cached
  // behind computed(), recomputed only when the diagnostics revision or the document changes.
  get diagnosticsByLine() {
    return computed<Map<number, DiagnosticLineMark[]>>(() => {
      const editor = this.editor;
      const client = this.languageClientInstance;
      if (this.showingDiff.value || !editor.hasDocument.value || !client) return new Map();
      void client.diagnosticsRevision.value; // reactivity: repaint when diagnostics change
      void editor.document.revision.value;
      const total = client.diagnosticCountFor(editor.document);
      if (total === 0) return new Map();
      const byLine = new Map<number, DiagnosticLineMark[]>();
      for (const diagnostic of client.diagnosticSlice(editor.document, 0, total)) {
        const firstLine = diagnostic.range.start.line;
        const lastLine = diagnostic.range.end.line;
        for (let line = firstLine; line <= lastLine; line += 1) {
          if (line < 0 || line >= editor.document.lineCount) continue;
          const startColumn = line === firstLine ? diagnostic.range.start.column : 0;
          const endColumn =
            line === lastLine
              ? diagnostic.range.end.column
              : EditorCoordinates.Class.graphemeCount(editor.document.line(line));
          const marks = byLine.get(line) ?? [];
          marks.push({ startColumn, endColumn: Math.max(startColumn, endColumn), severity: diagnostic.severity });
          byLine.set(line, marks);
        }
      }
      return byLine;
    });
  }

  // invariant: The editor gutter reflects HEAD changes (src/modules/diff/diff.invariants.md)
  async refreshActiveHeadText(): Promise<void> {
    const requestToken = ++this.activeHeadTextRequestToken;
    const editor = this.editor;
    if (this.showingDiff.value || !editor.hasDocument.value || !editor.document.path) {
      this.activeHeadText.value = '';
      return;
    }

    const documentPath = editor.document.path;
    if (Files.Class.confineToRoot(this.root, documentPath) === null) {
      this.activeHeadText.value = '';
      return;
    }
    const workspaceRelativePath = Files.Class.relative(this.root, documentPath);
    const headText = await this.gitFileText('HEAD', workspaceRelativePath);
    if (
      requestToken === this.activeHeadTextRequestToken &&
      !this.showingDiff.value &&
      this.editor.hasDocument.value &&
      this.editor.document.path === documentPath
    ) {
      this.activeHeadText.value = headText;
    }
  }
  private workingFileText(filePath: string): string {
    const absolute = Files.Class.join(this.root, filePath);
    // Git lists an untracked DIRECTORY (e.g. node_modules/, including a symlink-to-dir — statSync
    // follows symlinks) as a single entry that GitRows classifies as kind:'file'. Reading it as a file
    // throws EISDIR, and the throw escapes through OpenTUI's mouse dispatch and crashes the app. Guard
    // the read against directories, and try/catch so any non-regular file (fifo/socket/broken symlink)
    // degrades to an empty diff instead of taking the app down.
    if (!Files.Class.exists(absolute) || Files.Class.isDir(absolute)) return '';
    try {
      return Files.Class.read(absolute);
    } catch {
      return '';
    }
  }
  private openDiffView(request: Omit<DiffRequest, 'token'>): void {
    this.diffRequest.value = { token: ++this.diffRequestToken, ...request };
    this.showingDiff.value = true; // the DiffView shows OVER the tabs (transient view)
    this.focus.value = 'editor'; // keyboard to the diff; sidebarView stays 'git'
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

  get hasLiveGitWatcher(): boolean {
    return this.gitWatcher !== null;
  }

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
  // panel keeps the panel visible while the editor takes focus (VS Code behavior). ONE ref holds ONE
  // value, so "exactly one activity item is active per workspace" is true by representation.
  get sidebarView() {
    return ref<SidebarView>('files');
  }
  get name() {
    return ref('');
  }
  /** The linked-worktree name when the root is a linked git worktree — its `.git` is a gitdir-pointer
   *  FILE, not a directory — else null. The name is the worktree root's folder name. */
  get worktreeName() {
    return ref<string | null>(null);
  }
  /** The second tab-strip line for this project: the checked-out BRANCH, live-reactive so a
   *  `git checkout`/`switch` updates it (GitWatcher watches HEAD). git reports a detached HEAD as
   *  the literal branch "(detached)"; show the short HEAD SHA instead, which actually identifies it.
   *  Empty until git first reports, or when the root is not a repository. */
  get tabDetail(): string {
    const branch = this.git.value?.branch.value ?? '';
    if (branch === '(detached)') {
      const head = this.git.value?.head.value ?? '';
      return head ? head.slice(0, 7) : '(detached)';
    }
    return branch;
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
    // Name is the actual folder name, never "." — resolve to the absolute path first so a root of "."
    // (or a trailing-slash path) still yields the real directory name.
    const absoluteRoot = Files.Class.absolute(root);
    // Line 1 is the PROJECT name, shared by the main checkout AND all its linked worktrees, so every
    // worktree tab reads as the same project (its branch on line 2 tells them apart). The project root
    // is the parent of the git COMMON dir: for the main checkout that is `<root>/.git` -> <root>; for a
    // linked worktree it is `<project>/.git` -> <project>. Falls back to the folder name off-repo.
    this.name.value = projectNameForRoot(absoluteRoot) || Files.Class.basename(absoluteRoot) || absoluteRoot;
    // A linked git worktree keeps `.git` as a pointer FILE ("gitdir: …"), never a directory — the
    // main checkout's `.git` is a directory. The worktree's own name is its root folder name.
    const gitPointerPath = Files.Class.join(absoluteRoot, '.git');
    this.worktreeName.value =
      Files.Class.exists(gitPointerPath) && !Files.Class.isDir(gitPointerPath)
        ? Files.Class.basename(absoluteRoot) || null
        : null;
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

  // invariant: N open workspaces do not cost N live GitWatchers (workspace.invariants.md)
  /** Release per-root live resources while preserving this workspace's resumable model state. */
  suspendOwnedResources(): void {
    this.gitWatcher?.dispose();
    this.gitWatcher = null;
    // A suspended (background) workspace holds no language-server subprocess; resuming recreates
    // the client lazily through the buffer seams / the next semantic request.
    // invariant: Client disposal releases the server (src/modules/lsp/lsp.invariants.md)
    void this.languageClientInstance?.dispose();
    this.languageClientInstance = null;
    this.buffers.deactivate();
  }

  // invariant: N open workspaces do not cost N live GitWatchers (workspace.invariants.md)
  /** Recreate per-root live resources when this workspace becomes the observed project again. */
  resumeOwnedResources(): void {
    this.buffers.reactivate();
    if (this.root && this.git.value && !this.gitWatcher) {
      this.gitWatcher = this.createGitWatcher(this.root, this.git.value);
      void this.git.value.refresh();
    }
  }

  /** Tear down owned resources with effects/handles (the working-tree watcher, the language
   *  client's subprocess, and the open buffers). */
  dispose(): void {
    this.activeHeadTextRequestToken += 1;
    this.gitWatcher?.dispose();
    this.gitWatcher = null;
    // invariant: Client disposal releases the server (src/modules/lsp/lsp.invariants.md)
    void this.languageClientInstance?.dispose();
    this.languageClientInstance = null;
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
  /**
   * Switch the sidebar to an activity-bar view (a bar click OR the Ctrl+Shift+E/G/X chord). This is
   * the SINGLE writer the activity bar and its keybindings both call, so the active view is one
   * decision per workspace. Focus follows the view for the interactive panels (files/git) so their
   * keyboard navigation is live immediately; the extensions placeholder is display-only, so it leaves
   * keyboard focus where it is. Switching TO git kicks the same non-blocking refresh Ctrl+G does.
   *
   * invariant: The active activity item determines the sidebar content (src/modules/ui/ui.invariants.md)
   */
  showSidebarView(view: SidebarView): void {
    this.sidebarView.value = view;
    if (view === 'files') {
      this.focus.value = 'files';
    } else if (view === 'git') {
      this.focus.value = 'git';
      void this.git.value?.refresh();
      void this.commitLog.value?.ensureRange(0, 50);
    }
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
    // The two SIDES as of the commit: parent (empty on a root commit) vs the commit itself.
    const previousVersionText = await this.gitFileText(`${sha}^`, filePath);
    const currentVersionText = await this.gitFileText(sha, filePath);
    this.openDiffView({
      previousVersionText,
      currentVersionText,
      previousVersionPath: `${filePath} @ ${sha.slice(0, 7)}^`,
      currentVersionPath: filePath,
    });
  }

  /** A wheel notch: add a momentum impulse (the frame loop then glides the log). VERTICAL regimes use
   *  the higher-ceiling profile (item E) so a hard fling covers ground fast; horizontal stays default. */
  impulseGitLog(deltaRows: number): void {
    this.gitPanel.logMomentum.value = Momentum.Class.addImpulse(this.gitPanel.logMomentum.value, deltaRows, this.verticalMomentum);
  }

  impulseEditorVerticalScroll(deltaRows: number): void {
    const viewport = this.editor.viewport;
    viewport.verticalScrollMomentum.value = Momentum.Class.addImpulse(viewport.verticalScrollMomentum.value, deltaRows, this.verticalMomentum);
  }

  impulseEditorHorizontalScroll(deltaColumns: number): void {
    const viewport = this.editor.viewport;
    viewport.horizontalScrollMomentum.value = Momentum.Class.addImpulse(viewport.horizontalScrollMomentum.value, deltaColumns);
  }

  impulseTreeScroll(deltaRows: number): void {
    this.tree.selectionMomentum.value = Momentum.Class.addImpulse(this.tree.selectionMomentum.value, deltaRows, this.verticalMomentum);
  }

  impulseTreeHorizontalScroll(deltaColumns: number): void {
    this.tree.horizontalScrollMomentum.value = Momentum.Class.addImpulse(
      this.tree.horizontalScrollMomentum.value,
      deltaColumns,
    );
  }

  impulseGitChangesScroll(deltaRows: number): void {
    this.gitPanel.changesMomentum.value = Momentum.Class.addImpulse(this.gitPanel.changesMomentum.value, deltaRows, this.verticalMomentum);
  }

  impulseGitChangesHorizontalScroll(deltaColumns: number): void {
    this.gitPanel.changesHorizontalMomentum.value = Momentum.Class.addImpulse(
      this.gitPanel.changesHorizontalMomentum.value,
      deltaColumns,
    );
  }

  impulseGitLogHorizontalScroll(deltaColumns: number): void {
    this.gitPanel.logHorizontalMomentum.value = Momentum.Class.addImpulse(
      this.gitPanel.logHorizontalMomentum.value,
      deltaColumns,
    );
  }

  /** Halt the log glide immediately (keyboard paging / a jump — One-Writer-Per-Regime). */
  haltGitLogScroll(): void {
    this.gitPanel.logMomentum.value = Momentum.Class.halt();
  }

  haltTreeScroll(): void {
    this.tree.selectionMomentum.value = Momentum.Class.halt();
  }

  haltTreeHorizontalScroll(): void {
    this.tree.horizontalScrollMomentum.value = Momentum.Class.halt();
  }

  haltGitChangesScroll(): void {
    this.gitPanel.changesMomentum.value = Momentum.Class.halt();
  }

  haltGitChangesHorizontalScroll(): void {
    this.gitPanel.changesHorizontalMomentum.value = Momentum.Class.halt();
  }

  haltGitLogHorizontalScroll(): void {
    this.gitPanel.logHorizontalMomentum.value = Momentum.Class.halt();
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
    const gitLogStep = Momentum.Class.stepMomentum(gitPanel.logMomentum.value, dtSeconds, this.verticalMomentum);
    gitPanel.logMomentum.value = gitLogStep.momentum;
    if (gitLogStep.rows !== 0) this.scrollGitLog(gitLogStep.rows);

    const editorVerticalStep = Momentum.Class.stepMomentum(editorViewport.verticalScrollMomentum.value, dtSeconds, this.verticalMomentum);
    editorViewport.verticalScrollMomentum.value = editorVerticalStep.momentum;
    if (editorVerticalStep.rows !== 0) {
      // In wrap mode scrollTop is a VISUAL-row offset, so the momentum glide clamps to the wrapped
      // extent (totalVisualRows) — reaching the true last visual row, same engine as non-wrap.
      const editor = this.editor;
      const totalRows = editor.wordWrap.value
        ? EditorWrap.Class.totalVisualRows(editor.document, editor.wrapWidth())
        : editor.document.lineCount;
      editorViewport.scrollBy(editorVerticalStep.rows, totalRows);
    }

    const editorHorizontalStep = Momentum.Class.stepMomentum(editorViewport.horizontalScrollMomentum.value, dtSeconds);
    editorViewport.horizontalScrollMomentum.value = editorHorizontalStep.momentum;
    if (editorHorizontalStep.rows !== 0) {
      let widestVisibleLineWidth = 0;
      for (const line of this.editor.document.slice(editorViewport.scrollTop.value, editorViewport.height.value)) {
        widestVisibleLineWidth = Math.max(widestVisibleLineWidth, EditorCoordinates.Class.lineWidth(line));
      }
      editorViewport.scrollByColumns(editorHorizontalStep.rows, widestVisibleLineWidth);
    }

    const treeStep = Momentum.Class.stepMomentum(this.tree.selectionMomentum.value, dtSeconds, this.verticalMomentum);
    this.tree.selectionMomentum.value = treeStep.momentum;
    // Wheel scrolls the tree WINDOW (independent offset), not the selection — so the list scrolls as
    // one uniform surface and the selection highlight travels with its row (git-changes behaviour).
    if (treeStep.rows !== 0) this.tree.scrollBy(treeStep.rows);

    const treeHorizontalStep = Momentum.Class.stepMomentum(this.tree.horizontalScrollMomentum.value, dtSeconds);
    this.tree.horizontalScrollMomentum.value = treeHorizontalStep.momentum;
    if (treeHorizontalStep.rows !== 0) this.tree.scrollByColumns(treeHorizontalStep.rows);

    const changesStep = Momentum.Class.stepMomentum(gitPanel.changesMomentum.value, dtSeconds, this.verticalMomentum);
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

    const changesHorizontalStep = Momentum.Class.stepMomentum(
      gitPanel.changesHorizontalMomentum.value,
      dtSeconds,
    );
    gitPanel.changesHorizontalMomentum.value = changesHorizontalStep.momentum;
    if (changesHorizontalStep.rows !== 0) gitPanel.scrollChangesByColumns(changesHorizontalStep.rows);

    const logHorizontalStep = Momentum.Class.stepMomentum(gitPanel.logHorizontalMomentum.value, dtSeconds);
    gitPanel.logHorizontalMomentum.value = logHorizontalStep.momentum;
    if (logHorizontalStep.rows !== 0) gitPanel.scrollLogByColumns(logHorizontalStep.rows);

    return [
      gitLogStep.momentum,
      editorVerticalStep.momentum,
      editorHorizontalStep.momentum,
      treeStep.momentum,
      treeHorizontalStep.momentum,
      changesStep.momentum,
      changesHorizontalStep.momentum,
      logHorizontalStep.momentum,
    ].some((momentum) => Momentum.Class.isMoving(momentum));
  }

  /** Open the DIFF of the file at a changes-row (row click / 'o'): the git panel STAYS in the
   *  sidebar, the editor shows the change vs its previous state, read-only, diff-colored. */
  async openChangeAtRow(rowIndex: number): Promise<void> {
    const git = this.git.value;
    if (!git) return;
    const rows = GitRows.Class.buildChangeRows(git.staged.value, git.unstaged.value, git.untracked.value);
    const row = rows[rowIndex];
    if (row?.kind !== 'file') return;
    // The two SIDES per bucket: staged = HEAD vs index; unstaged = index vs worktree; untracked = ∅ vs worktree.
    let previousVersionText = '';
    let currentVersionText = '';
    if (row.bucket === 'staged') {
      previousVersionText = await this.gitFileText('HEAD', row.path);
      currentVersionText = await this.gitFileText('', row.path); // ':path' = the index version
    } else if (row.bucket === 'unstaged') {
      previousVersionText = await this.gitFileText('', row.path);
      currentVersionText = this.workingFileText(row.path);
    } else {
      currentVersionText = this.workingFileText(row.path); // untracked: no previous side
    }
    this.openDiffView({
      previousVersionText,
      currentVersionText,
      previousVersionPath: row.path,
      currentVersionPath: row.path,
    });
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

  // --- navigation history (Go Back / Go Forward) ---------------------------
  // A programmatic back()/forward() restore MUST NOT itself record a new location, or the stack
  // could never be escaped. This guard is raised around a history restore AND around the internal
  // openFileInTab of a go-to-definition jump (which records its own source + destination
  // explicitly). It is a plain field — an internal control flag, not observable view state.
  // invariant: Programmatic history navigation does not record new history (src/modules/navigation/navigation.invariants.md)
  private suppressLocationRecording = false;

  /** Run `action` with location recording suppressed (history restore / an already-recorded jump). */
  private withSuppressedLocationRecording(action: () => void): void {
    const previouslySuppressed = this.suppressLocationRecording;
    this.suppressLocationRecording = true;
    try {
      action();
    } finally {
      this.suppressLocationRecording = previouslySuppressed;
    }
  }

  /** Snapshot the visible editor's current location into the history (no-op without a real
   *  document — the empty-state and read-only diff editors carry no navigable path). */
  recordCurrentLocation(): void {
    const editor = this.editor;
    if (!editor.hasDocument.value || !editor.document.path) return;
    this.navigationHistory.record({
      documentPath: editor.document.path,
      line: editor.cursor.line.value,
      column: editor.cursor.col.value,
    });
  }

  /** Open a recorded location and land the cursor on it — the shared back/forward restore path.
   *  Suppresses recording so replaying history never mutates it. */
  private restoreNavigationLocation(location: Location): void {
    this.withSuppressedLocationRecording(() => {
      this.openFileInTab(location.documentPath);
      this.focus.value = 'editor';
      this.editor.placeCursor(location.line, location.column);
      this.editor.revealCursor();
    });
  }

  /** Go Back (Alt+[): restore the previous location in the trail; safe no-op at the start. */
  navigateBack(): void {
    const location = this.navigationHistory.back();
    if (location) this.restoreNavigationLocation(location);
  }

  /** Go Forward (Alt+]): restore the next location in the trail; safe no-op at the end. */
  navigateForward(): void {
    const location = this.navigationHistory.forward();
    if (location) this.restoreNavigationLocation(location);
  }

  /** Open `path` as a tab: focus its tab if already open, else add a new active one. Records the
   *  location left (before the switch) AND the location arrived at (after) into the navigation
   *  history, unless recording is suppressed (a history restore, or a jump that records itself). */
  openFileInTab(path: string): void {
    if (!this.suppressLocationRecording) this.recordCurrentLocation(); // where we were, before we leave
    this.showingDiff.value = false; // a real file replaces the transient diff view
    this.diffRequest.value = null;
    this.buffers.open(path);
    void this.refreshActiveHeadText();
    if (!this.suppressLocationRecording) this.recordCurrentLocation(); // where we arrived
  }

  /** Resolve a rendered Markdown reference through the existing workspace confinement boundary.
   * External URLs and directories are deliberately not editor targets. */
  // invariant: A file reference opens from rendered Markdown (src/modules/markdown/markdown.invariants.md)
  resolveFileReference(reference: string): string | null {
    const withoutFragment = reference.split('#', 1)[0]?.split('?', 1)[0]?.trim() ?? '';
    if (!withoutFragment || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(withoutFragment)) return null;
    let decodedReference = withoutFragment;
    try {
      decodedReference = decodeURIComponent(withoutFragment);
    } catch {
      // A malformed percent escape is not a file target.
      return null;
    }
    const candidatePaths = [
      Files.Class.confineToRoot(this.root, decodedReference),
      this.editor.hasDocument.value
        ? Files.Class.confineToRoot(Files.Class.dirname(this.editor.document.path), decodedReference)
        : null,
    ];
    for (const candidatePath of candidatePaths) {
      if (
        candidatePath &&
        Files.Class.confineToRoot(this.root, candidatePath) !== null &&
        Files.Class.exists(candidatePath) &&
        !Files.Class.isDir(candidatePath)
      ) {
        return candidatePath;
      }
    }
    return null;
  }

  openFileReference(reference: string): boolean {
    const resolvedPath = this.resolveFileReference(reference);
    if (!resolvedPath) return false;
    this.openFileInTab(resolvedPath);
    this.focus.value = 'editor';
    return true;
  }

  /** Activate an already-open tab by index (tab click / cycle). */
  activateTab(index: number): void {
    this.showingDiff.value = false;
    this.diffRequest.value = null;
    this.buffers.activate(index);
    this.focus.value = 'editor';
    void this.refreshActiveHeadText();
  }

  /** Cycle tabs by `delta`, wrapping (Ctrl+Tab / Ctrl+PageUp-Down). */
  cycleTab(delta: number): void {
    if (this.buffers.count === 0) return;
    this.showingDiff.value = false;
    this.diffRequest.value = null;
    this.buffers.cycle(delta);
    this.focus.value = 'editor';
    void this.refreshActiveHeadText();
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
    void this.refreshActiveHeadText();
  }

  /** Save the active file and refresh its HEAD-side cache through the same workspace seam. */
  saveActiveFile(): boolean {
    const saved = this.editor.save();
    if (saved) {
      this.buffers.syncActiveDirty();
      void this.refreshActiveHeadText();
    }
    return saved;
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
