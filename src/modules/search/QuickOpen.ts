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

export interface QuickOpenOptions {
  enumerateProjectFiles?: ProjectFileEnumerator;
  enumerateSiblingFolders?: SiblingFolderEnumerator;
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

  private projectFiles: readonly string[] = [];
  private latestEnumerationRequestIdentifier = 0;

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
   * Open the project-folder picker. When the current workspace root is given, the input is
   * prefilled with the ABSOLUTE path of the root's parent directory and the parent's subfolders
   * (the current project's siblings) become the fuzzy-searchable candidates. Without a root the
   * picker stays a blank free-form path prompt.
   */
  showWorkspacePath(workspaceRoot?: string): void {
    ++this.latestEnumerationRequestIdentifier;
    this.open.value = true;
    this.mode.value = 'workspacePath';
    this.query.value = '';
    this.errorMessage.value = '';
    this.projectFiles = [];
    this.matches.value = [];
    this.selectedIndex.value = -1;

    if (workspaceRoot === undefined) return;

    const parentDirectory = Files.Class.dirname(Files.Class.absolute(workspaceRoot));
    this.query.value = parentDirectory;
    this.projectFiles = this.enumerateSiblingFolders(parentDirectory);
    this.refilter();
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

  /** Return the selected path. The caller owns opening the file and closing quick-open. */
  activate(): string | null {
    if (this.mode.value === 'workspacePath') {
      const selectedFolder = this.matches.value[this.selectedIndex.value]?.path;
      if (selectedFolder !== undefined) return selectedFolder;
      const workspacePath = this.query.value.trim();
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

  private refilter(): void {
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
}

export namespace QuickOpen {
  export const $Class = $QuickOpen;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
