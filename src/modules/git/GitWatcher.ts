// Disposable working-directory watcher. A storm of filesystem events owns only one resettable
// timer and therefore produces one Git refresh after the tree settles.
//
// invariant: Filesystem notifications arrive in bursts (src/modules/git/git.invariants.md)
// invariant: The watcher has one disposable debounce (src/modules/git/git.invariants.md)
import { watch, type FSWatcher } from 'node:fs';
import type { GitRepository } from './GitRepository';

export interface GitWatcherOptions {
  debounceMs?: number;
}

class $GitWatcher {
  private watcher: FSWatcher | null = null;
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
    return this.watcher !== null && !this.disposed;
  }

  start(): boolean {
    if (this.disposed || this.watcher) return this.active;
    try {
      this.watcher = watch(this.cwd, { recursive: true }, () => this.scheduleRefresh());
      this.watcher.on('error', () => this.onWatcherError());
      return true;
    } catch {
      try {
        this.watcher = watch(this.cwd, () => this.scheduleRefresh());
        this.watcher.on('error', () => this.onWatcherError());
        return true;
      } catch {
        this.watcher = null;
        return false;
      }
    }
  }

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

  private onWatcherError(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.watcher?.close();
    this.watcher = null;
  }
}

export namespace GitWatcher {
  export const $Class = $GitWatcher;
  export let Class = $GitWatcher;
  export type Model = InstanceType<typeof Class>;
}
