// Disposable working-directory watcher. A storm of filesystem events owns only one resettable
// timer and therefore produces one Git refresh after the tree settles.
//
// It watches the working tree by WALKING it and establishing one NON-recursive watch per
// directory, SKIPPING every directory git considers ignored (queried with `git check-ignore`)
// plus `.git`. A single recursive watch on the root would descend into ignored trees like
// `node_modules` — thousands of nested directories, each an open filesystem watch handle, a real
// handle/memory sink on large projects — and on this platform Bun's recursive watch does not even
// reliably deliver nested events. The per-directory walk instead never opens a watch handle inside
// an ignored directory: an ignored path is pruned before its watch is ever created.
//
// invariant: Filesystem notifications arrive in bursts (src/modules/git/git.invariants.md)
// invariant: The watcher has one disposable debounce (src/modules/git/git.invariants.md)
// invariant: The watcher never watches inside an ignored directory (src/modules/git/git.invariants.md)
import { watch, readdirSync, statSync, type FSWatcher } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { GitRepository } from './GitRepository';

export interface GitWatcherOptions {
  debounceMs?: number;
}

// Directories always skipped when git cannot answer whether a path is ignored (no repository, or
// git is unavailable). Last-resort fallback only — the authoritative source is `git check-ignore`,
// which respects the repository's real .gitignore rather than this fixed list.
const FALLBACK_IGNORED_DIRECTORY_NAMES = new Set(['node_modules', '.git', 'dist']);

class $GitWatcher {
  private readonly directoryWatchers = new Map<string, FSWatcher>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly debounceMs: number;

  constructor(
    readonly cwd: string,
    private readonly repository: GitRepository.Model,
    options: GitWatcherOptions = {},
  ) {
    this.debounceMs = Math.max(0, options.debounceMs ?? 80);
    this.start();
  }

  get active(): boolean {
    return this.directoryWatchers.size > 0 && !this.disposed;
  }

  /** How many directories currently hold a watch handle. No entry ever points inside an ignored
   *  directory — the walk prunes ignored paths before a watch is created. */
  get watchedDirectoryCount(): number {
    return this.directoryWatchers.size;
  }

  /** The absolute paths of every watched directory (for verification that ignored subtrees such as
   *  `node_modules` were never watched). */
  watchedDirectories(): string[] {
    return [...this.directoryWatchers.keys()];
  }

  start(): boolean {
    if (this.disposed || this.directoryWatchers.size > 0) return this.active;
    try {
      this.walkAndWatch(this.cwd);
    } catch {
      // Catastrophic walk failure (unreadable root): fall back to a single non-recursive watch on
      // the root so top-level changes still refresh, rather than watching nothing.
      this.watchDirectory(this.cwd);
    }
    return this.active;
  }

  /** Establish a non-recursive watch on `directory`, then recurse into each child directory git
   *  does not ignore (and that is not `.git`). Symlinked directories are not followed. */
  private walkAndWatch(directory: string): void {
    if (this.disposed) return;
    if (!this.watchDirectory(directory)) return;

    let childDirectoryNames: string[];
    try {
      childDirectoryNames = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== '.git')
        .map((entry) => entry.name);
    } catch {
      return;
    }
    if (childDirectoryNames.length === 0) return;

    for (const childName of this.filterIgnoredChildren(directory, childDirectoryNames)) {
      this.walkAndWatch(join(directory, childName));
    }
  }

  private watchDirectory(directory: string): boolean {
    if (this.disposed || this.directoryWatchers.has(directory)) return false;
    try {
      const watcher = watch(directory, (_eventType, changedName) =>
        this.onDirectoryEvent(directory, changedName),
      );
      watcher.on('error', () => this.onWatcherError(directory));
      this.directoryWatchers.set(directory, watcher);
      return true;
    } catch {
      return false;
    }
  }

  // invariant: The watcher never watches inside an ignored directory (src/modules/git/git.invariants.md)
  private filterIgnoredChildren(parentDirectory: string, childNames: string[]): string[] {
    const ignoredNames = this.queryIgnoredNames(parentDirectory, childNames);
    if (ignoredNames === null) {
      // git could not answer (no repository / git unavailable): fall back to the fixed skip set.
      return childNames.filter((name) => !FALLBACK_IGNORED_DIRECTORY_NAMES.has(name));
    }
    return childNames.filter((name) => !ignoredNames.has(name));
  }

  /** Ask git which of `childNames` (relative to `parentDirectory`) are ignored. `git check-ignore`
   *  exits 0 when at least one path is ignored, 1 when none are, and otherwise fails (not a
   *  repository, git missing) — a failure returns null so the caller can fall back. */
  private queryIgnoredNames(parentDirectory: string, childNames: string[]): Set<string> | null {
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync('git', ['check-ignore', '-z', '--stdin'], {
        cwd: parentDirectory,
        input: childNames.join('\0'),
        encoding: 'utf8',
      });
    } catch {
      return null;
    }
    if (result.error) return null;
    if (result.status !== 0 && result.status !== 1) return null;
    const ignoredNames = new Set<string>();
    for (const ignoredName of String(result.stdout).split('\0')) {
      if (ignoredName.length > 0) ignoredNames.add(ignoredName);
    }
    return ignoredNames;
  }

  private onDirectoryEvent(directory: string, changedName: string | Buffer | null): void {
    if (this.disposed) return;
    this.scheduleRefresh();
    // A newly created subdirectory (a 'rename' that added an entry) needs its own watch — but only
    // if git does not ignore it. Deletions or file changes resolve to no new directory and are
    // covered by the refresh above.
    if (!changedName) return;
    const childName = typeof changedName === 'string' ? changedName : changedName.toString();
    if (childName.length === 0 || childName === '.git') return;
    const childPath = join(directory, childName);
    if (this.directoryWatchers.has(childPath)) return;
    const childStats = statSync(childPath, { throwIfNoEntry: false });
    if (!childStats || !childStats.isDirectory()) return;
    if (this.filterIgnoredChildren(directory, [childName]).length === 0) return;
    this.walkAndWatch(childPath);
  }

  // invariant: The watcher has one disposable debounce (src/modules/git/git.invariants.md)
  protected scheduleRefresh(): void {
    if (this.disposed) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flushRefresh(), this.debounceMs);
    this.debounceTimer.unref?.();
  }

  private flushRefresh(): void {
    this.debounceTimer = null;
    if (!this.disposed) void this.repository.refresh();
  }

  private onWatcherError(directory: string): void {
    const watcher = this.directoryWatchers.get(directory);
    watcher?.close();
    this.directoryWatchers.delete(directory);
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    for (const watcher of this.directoryWatchers.values()) watcher.close();
    this.directoryWatchers.clear();
  }
}

export namespace GitWatcher {
  export const $Class = $GitWatcher;
  export let Class = $GitWatcher;
  export type Model = InstanceType<typeof Class>;
}
