import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';
import { CommandScoring } from '../commands/CommandScoring';
import { TextEditing } from '../editor/TextEditing';
import { Files } from '../system/Files';
import { Processes } from '../system/Processes';

export interface QuickOpenMatch {
  path: string;
  score: number;
}

export type ProjectFileEnumerator = (projectRoot: string) => Promise<readonly string[]>;

export type SiblingFolderEnumerator = (parentDirectory: string) => readonly string[];

export type DirectoryPredicate = (path: string) => boolean;

export interface QuickOpenOptions {
  enumerateProjectFiles?: ProjectFileEnumerator;
  enumerateSiblingFolders?: SiblingFolderEnumerator;
  isDirectory?: DirectoryPredicate;
}

export type QuickOpenMode = 'files' | 'workspacePath';

class $QuickOpen {
  constructor(readonly options: QuickOpenOptions = {}) {}

  get open() {
    return ref(false);
  }

  get query() {
    return ref('');
  }

  get mode() {
    return ref<QuickOpenMode>('files');
  }

  get errorMessage() {
    return ref('');
  }

  get matches() {
    return shallowRef<readonly QuickOpenMatch[]>([]);
  }

  get selectedIndex() {
    return ref(-1);
  }

  // Transient pointer highlight over a result row — never selection truth (mirrors the tree/git panes'
  // hoveredIndex). The renderer paints it as a subtle row background; a click promotes it to selection.
  get hoveredIndex() {
    return ref(-1);
  }

  // True when the CURRENT open-project input path is an existing directory (what Enter would open).
  // Recomputed live on every keystroke in the path navigator; the input paints a warning glyph when
  // false so an un-openable path is obvious at a glance. Always true outside the path navigator.
  get workspacePathOpenable() {
    return ref(true);
  }

  private projectFiles: readonly string[] = [];
  private latestEnumerationRequestIdentifier = 0;

  // Path-navigator state (workspacePath mode): the directory currently listed and its subfolders,
  // cached so a keystroke that stays within the same directory re-filters instead of re-reading it.
  private workspaceDirectory: string | null = null;
  private workspaceSubfolders: readonly string[] = [];

  /** Open quick-open and replace its candidates with the project files reported by ripgrep. */
  async show(projectRoot: string): Promise<void> {
    const enumerationRequestIdentifier = ++this.latestEnumerationRequestIdentifier;
    this.open.value = true;
    this.mode.value = 'files';
    this.query.value = '';
    this.errorMessage.value = '';
    this.projectFiles = [];
    this.matches.value = [];
    this.selectedIndex.value = -1;
    this.hoveredIndex.value = -1;
    this.workspacePathOpenable.value = true;

    let enumeratedProjectFiles: readonly string[] = [];
    try {
      enumeratedProjectFiles = await this.enumerateProjectFiles(projectRoot);
    } catch {
      enumeratedProjectFiles = [];
    }

    // invariant: An async result can outlive the state it described (project.invariants.md)
    if (
      enumerationRequestIdentifier !== this.latestEnumerationRequestIdentifier ||
      !this.open.value
    ) {
      return;
    }

    this.projectFiles = enumeratedProjectFiles;
    this.refilter();
  }

  /** Replace the query and synchronously rebuild the ranked candidate list. */
  setQuery(text: string): void {
    this.query.value = text;
    this.errorMessage.value = '';
    this.refilter();
  }

  /**
   * Open the project-folder picker as a LIVE PATH NAVIGATOR (VS Code-style path completion). When the
   * current workspace root is given, the input is prefilled with the ABSOLUTE path of the root's parent
   * directory (trailing slash) so the picker opens listing the parent's subfolders — the current
   * project's siblings. Typing re-roots the listing live; clicking a folder drills into it; Enter opens
   * the current path. Without a root the picker stays a blank free-form path prompt.
   */
  // invariant: The open-project path input is a live directory navigator (src/modules/search/search.invariants.md)
  showWorkspacePath(workspaceRoot?: string): void {
    ++this.latestEnumerationRequestIdentifier;
    this.open.value = true;
    this.mode.value = 'workspacePath';
    this.query.value = '';
    this.errorMessage.value = '';
    this.projectFiles = [];
    this.matches.value = [];
    this.selectedIndex.value = -1;
    this.hoveredIndex.value = -1;
    this.workspacePathOpenable.value = true;
    this.workspaceDirectory = null;
    this.workspaceSubfolders = [];

    if (workspaceRoot === undefined) return;

    const parentDirectory = Files.Class.dirname(Files.Class.absolute(workspaceRoot));
    this.setQuery(`${parentDirectory}/`);
  }

  /** Drill into the highlighted subfolder: complete the path with its name + `/` and re-list its
   *  contents. The mouse click and the keyboard both reach the navigator through this one method. */
  // invariant: The open-project path input is a live directory navigator (src/modules/search/search.invariants.md)
  navigateIntoSelected(): void {
    const folderPath = this.matches.value[this.selectedIndex.value]?.path;
    if (folderPath === undefined) return;
    this.setQuery(`${folderPath}/`);
  }

  setError(message: string): void {
    this.errorMessage.value = message;
  }

  // invariant: Word deletion uses the navigation boundary (src/modules/editor/editor.invariants.md)
  deletePreviousWord(): void {
    this.setQuery(TextEditing.Class.deletePreviousWord(this.query.value).text);
  }

  /** Move the active match without wrapping beyond either end of the list. */
  moveSelection(delta: number): void {
    if (this.matches.value.length === 0) {
      this.selectedIndex.value = -1;
      return;
    }

    this.selectedIndex.value = Math.max(
      0,
      Math.min(this.selectedIndex.value + delta, this.matches.value.length - 1),
    );
  }

  /** Click-set the active match to a pointed row (mouse selection); ignored when the row has no match. */
  // invariant: Search results are click-set and highlight-shown (src/modules/search/search.invariants.md)
  setSelectedIndex(index: number): void {
    if (index < 0 || index >= this.matches.value.length) return;
    this.selectedIndex.value = index;
  }

  /** Point the transient hover highlight at a row; an out-of-range row (or -1) clears it. */
  setHoveredIndex(index: number): void {
    this.hoveredIndex.value = index >= 0 && index < this.matches.value.length ? index : -1;
  }

  /** Return the path to open. The caller owns opening the file/folder and closing quick-open. In
   *  files mode this is the selected file; in the path-navigator this is the CURRENT input path (the
   *  folder you have navigated to), trailing slash stripped — folders are drilled into, not opened, by
   *  a click, so Enter commits wherever the input currently points. */
  activate(): string | null {
    if (this.mode.value === 'workspacePath') {
      const workspacePath = stripTrailingSlash(this.query.value.trim());
      return workspacePath.length > 0 ? workspacePath : null;
    }
    return this.matches.value[this.selectedIndex.value]?.path ?? null;
  }

  close(): void {
    ++this.latestEnumerationRequestIdentifier;
    this.open.value = false;
    this.mode.value = 'files';
    this.query.value = '';
    this.errorMessage.value = '';
    this.projectFiles = [];
    this.matches.value = [];
    this.selectedIndex.value = -1;
    this.hoveredIndex.value = -1;
    this.workspacePathOpenable.value = true;
  }

  protected async enumerateProjectFiles(projectRoot: string): Promise<readonly string[]> {
    if (this.options.enumerateProjectFiles) {
      return this.options.enumerateProjectFiles(projectRoot);
    }

    const ripgrepResult = await Processes.Class.run(['rg', '--files'], projectRoot);
    if (ripgrepResult.ok) {
      return ripgrepResult.stdout.split('\n').filter((filePath) => filePath.length > 0);
    }
    // Fallback when ripgrep is not installed: git's tracked + untracked-non-ignored files (the same
    // .gitignore-respecting set rg --files gives). Keeps go-to-file working on a machine without rg.
    const gitResult = await Processes.Class.run(
      ['git', 'ls-files', '--cached', '--others', '--exclude-standard'],
      projectRoot,
    );
    if (gitResult.ok) {
      return gitResult.stdout.split('\n').filter((filePath) => filePath.length > 0);
    }
    return [];
  }

  protected enumerateSiblingFolders(parentDirectory: string): readonly string[] {
    if (this.options.enumerateSiblingFolders) {
      return this.options.enumerateSiblingFolders(parentDirectory);
    }
    return Files.Class.list(parentDirectory)
      .filter((directoryEntry) => directoryEntry.isDir)
      .map((directoryEntry) => directoryEntry.path);
  }

  protected isDirectory(path: string): boolean {
    if (this.options.isDirectory) return this.options.isDirectory(path);
    return Files.Class.isDir(path);
  }

  private refilter(): void {
    if (this.mode.value === 'workspacePath') {
      this.refilterWorkspacePath();
      return;
    }

    const query = this.query.value;
    const scoredMatches: QuickOpenMatch[] = [];

    for (const filePath of this.projectFiles) {
      const score = CommandScoring.Class.fuzzyScore(query, filePath);
      if (score >= 0) scoredMatches.push({ path: filePath, score });
    }

    scoredMatches.sort(
      (firstMatch, secondMatch) =>
        firstMatch.score - secondMatch.score ||
        (firstMatch.path < secondMatch.path ? -1 : firstMatch.path > secondMatch.path ? 1 : 0),
    );
    this.matches.value = scoredMatches;
    this.selectedIndex.value = scoredMatches.length > 0 ? 0 : -1;
  }

  /**
   * The path navigator: split the input at the LAST `/` into the directory being browsed and the
   * filter segment after it. List that directory's subfolders (re-reading the filesystem only when the
   * directory changes — a keystroke within it re-filters the cache), rank them by the filter segment
   * (fuzzy, closest first; an empty segment lists all), and set them as the selectable open-targets.
   */
  // invariant: The open-project path input is a live directory navigator (src/modules/search/search.invariants.md)
  private refilterWorkspacePath(): void {
    const query = this.query.value;
    const lastSlashIndex = query.lastIndexOf('/');
    const directoryPrefix = lastSlashIndex >= 0 ? query.slice(0, lastSlashIndex + 1) : '';
    const filterSegment = lastSlashIndex >= 0 ? query.slice(lastSlashIndex + 1) : query;

    // Live validity for the alert affordance: the path Enter would open is an existing directory.
    // invariant: An un-openable open-project path is flagged live (src/modules/search/search.invariants.md)
    const candidatePath = stripTrailingSlash(query.trim());
    this.workspacePathOpenable.value = candidatePath.length > 0 && this.isDirectory(candidatePath);

    if (directoryPrefix !== this.workspaceDirectory) {
      this.workspaceDirectory = directoryPrefix;
      this.workspaceSubfolders =
        directoryPrefix.length === 0
          ? []
          : this.enumerateSiblingFolders(directoryForListing(directoryPrefix));
    }

    const scoredFolders: QuickOpenMatch[] = [];
    for (const folderPath of this.workspaceSubfolders) {
      const folderName = Files.Class.basename(folderPath);
      const score = filterSegment.length === 0 ? 0 : CommandScoring.Class.fuzzyScore(filterSegment, folderName);
      if (score >= 0) scoredFolders.push({ path: folderPath, score });
    }

    scoredFolders.sort(
      (firstFolder, secondFolder) =>
        firstFolder.score - secondFolder.score ||
        (firstFolder.path < secondFolder.path ? -1 : firstFolder.path > secondFolder.path ? 1 : 0),
    );
    this.matches.value = scoredFolders;
    this.selectedIndex.value = scoredFolders.length > 0 ? 0 : -1;
  }
}

/** The directory to enumerate for a `dir/` prefix: drop the trailing slash, but keep root `/` intact. */
function directoryForListing(directoryPrefix: string): string {
  if (directoryPrefix === '/') return '/';
  return directoryPrefix.endsWith('/') ? directoryPrefix.slice(0, -1) : directoryPrefix;
}

/** Strip a single trailing slash for opening a path, keeping root `/` intact. */
function stripTrailingSlash(path: string): string {
  if (path === '/') return '/';
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

export namespace QuickOpen {
  export const $Class = $QuickOpen;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
