// Reactive Git state for one working directory. Status arrays and the history page are
// wholesale-replaced compact records; request IDs prevent late subprocess results from
// overwriting newer state.
import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';
import { Clock } from '../system/Clock';
import { StatusChannel } from '../system/StatusChannel';
import { GitCommands, type GitCommandResult } from './GitCommands';
import {
  GitParsers,
  type CommitRecord,
  type GitFileRecord,
} from './git.parsers';

export interface LoadHistoryOptions {
  branch?: string;
  limit?: number;
  cursor?: string;
}

class $GitRepository {
  private refreshRequestId = 0;
  private historyRequestId = 0;
  private operationId = 0;

  constructor(readonly cwd: string) {}

  get branch() {
    return ref('');
  }
  get head() {
    return ref('');
  }
  get staged() {
    return shallowRef<GitFileRecord[]>([]);
  }
  get unstaged() {
    return shallowRef<GitFileRecord[]>([]);
  }
  get untracked() {
    return shallowRef<GitFileRecord[]>([]);
  }
  // invariant: History storage remains page bounded (src/modules/git/git.invariants.md)
  get historyPage() {
    return shallowRef<CommitRecord[]>([]);
  }
  get refreshing() {
    return ref(false);
  }
  get lastRefreshAt() {
    return ref<number | null>(null);
  }
  get error() {
    return ref<string | null>(null);
  }

  protected get GitCommands() {
    return GitCommands.Class;
  }
  protected get Clock() {
    return Clock.Class;
  }
  protected get StatusChannel() {
    return StatusChannel.Class;
  }

  private commandError(action: string, result: GitCommandResult): string {
    const detail = result.stderr.trim() || result.stdout.trim();
    return detail || `${action} exited with code ${result.code}`;
  }

  private publishStatus(): void {
    this.StatusChannel.update({
      gitBranch: this.branch.value,
      gitHead: this.head.value,
      gitStaged: this.staged.value.length,
      gitUnstaged: this.unstaged.value.length,
      gitUntracked: this.untracked.value.length,
      gitHistoryRows: this.historyPage.value.length,
      gitRefreshing: this.refreshing.value,
      gitLastRefreshAt: this.lastRefreshAt.value,
      gitError: this.error.value,
    });
  }

  // invariant: Only the newest Git request mutates state (src/modules/git/git.invariants.md)
  async refresh(): Promise<void> {
    const requestId = ++this.refreshRequestId;
    this.refreshing.value = true;
    this.error.value = null;
    this.publishStatus();

    try {
      const result = await this.GitCommands.statusPorcelainV2Branch(this.cwd);
      if (requestId !== this.refreshRequestId) return;
      if (result.code !== 0) {
        this.error.value = this.commandError('git status', result);
        return;
      }

      const status = GitParsers.Class.parseStatusPorcelainV2(result.stdout);
      if (requestId !== this.refreshRequestId) return;
      if (status.branch !== this.branch.value) {
        this.historyRequestId++;
        this.historyPage.value = [];
      }
      this.branch.value = status.branch;
      this.head.value = status.head;
      this.staged.value = status.staged;
      this.unstaged.value = status.unstaged;
      this.untracked.value = status.untracked;
      this.lastRefreshAt.value = this.Clock.now();
    } catch (error) {
      if (requestId !== this.refreshRequestId) return;
      this.error.value = `git status failed: ${String(error)}`;
    } finally {
      if (requestId === this.refreshRequestId) {
        this.refreshing.value = false;
        this.publishStatus();
      }
    }
  }

  // invariant: Only the newest Git request mutates state (src/modules/git/git.invariants.md)
  async loadHistory(options: LoadHistoryOptions = {}): Promise<CommitRecord[]> {
    const requestId = ++this.historyRequestId;
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const branch = options.branch ?? this.branch.value;

    try {
      const result = await this.GitCommands.log({
        cwd: this.cwd,
        branch: branch && branch !== '(detached)' ? branch : undefined,
        limit,
        cursor: options.cursor,
      });
      if (requestId !== this.historyRequestId) return [];
      if (result.code !== 0) {
        this.historyPage.value = [];
        this.error.value = this.commandError('git log', result);
        this.publishStatus();
        return [];
      }

      const commits = GitParsers.Class.parseLog(result.stdout).slice(0, limit);
      if (requestId !== this.historyRequestId) return [];
      this.historyPage.value = commits;
      this.error.value = null;
      this.publishStatus();
      return commits;
    } catch (error) {
      if (requestId !== this.historyRequestId) return [];
      this.historyPage.value = [];
      this.error.value = `git log failed: ${String(error)}`;
      this.publishStatus();
      return [];
    }
  }

  async stage(paths: string[]): Promise<boolean> {
    return this.runOperation('git add', () => this.GitCommands.stage(this.cwd, paths));
  }

  async unstage(paths: string[]): Promise<boolean> {
    return this.runOperation('git unstage', () =>
      this.GitCommands.unstage(this.cwd, paths),
    );
  }

  async stageAll(): Promise<boolean> {
    const paths = this.uniquePaths([...this.unstaged.value, ...this.untracked.value]);
    return this.stage(paths);
  }

  async unstageAll(): Promise<boolean> {
    return this.unstage(this.uniquePaths(this.staged.value));
  }

  private uniquePaths(records: GitFileRecord[]): string[] {
    return [...new Set(records.map((record) => record.path))];
  }

  private async runOperation(
    action: string,
    run: () => Promise<GitCommandResult>,
  ): Promise<boolean> {
    const operationId = ++this.operationId;
    let result: GitCommandResult;

    try {
      result = await run();
    } catch (error) {
      if (operationId === this.operationId) {
        this.error.value = `${action} failed: ${String(error)}`;
        this.publishStatus();
      }
      return false;
    }

    await this.refresh();
    if (result.code !== 0 && operationId === this.operationId) {
      this.error.value = this.commandError(action, result);
      this.publishStatus();
    }
    return result.code === 0;
  }

  dispose(): void {
    this.refreshRequestId++;
    this.historyRequestId++;
    this.operationId++;
    this.refreshing.value = false;
    // No owned effects here — bumping the request IDs makes any in-flight refresh/history/op inert.
    // (Do NOT call $stopEffects: it clears cached ref-getter STATE cells, corrupting the
    // publishStatus() read below and any final state — only effect-owning classes should call it.)
    this.publishStatus();
  }
}

export namespace GitRepository {
  export const $Class = $GitRepository;
  export let Class = Reactive($Class);
  export type Model = InstanceType<typeof Class>;
  export type Instance = typeof Class.Instance;
}
