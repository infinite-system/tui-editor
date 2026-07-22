// A virtualized, reactive window over a repository's commit history. Holds only a sparse cache of
// the commits near the visible window (never the whole 10k+ log), fetched in batched pages and
// evicted outside a keep-margin. Realizes "cost tracks the actively observed set" and, like the
// rest of the git module, "only the newest request mutates state" (stale supersession).
//
// The page fetch is injectable (constructor `fetch`) so the windowing/caching logic is unit-testable
// with no git; the default fetch shells out via GitCommands + GitParsers.
import { Reactive } from 'ivue';
import { ref, shallowRef } from 'vue';
import { GitCommands } from './GitCommands';
import { GitParsers, type CommitRecord } from './GitParsers';
import { GitWindow } from './GitWindow';

export type CommitPageFetch = (skip: number, limit: number) => Promise<CommitRecord[]>;

export interface CommitLogOptions {
  branch?: string;
  fetch?: CommitPageFetch;
}

class $CommitLog {
  constructor(
    readonly cwd: string,
    readonly options: CommitLogOptions = {},
  ) {}

  // invariant: Cost tracks the actively observed set (project.invariants.md)
  // Sparse cache: commit index -> record. Identity is replaced on every write so observers re-run.
  get cache() {
    return shallowRef(new Map<number, CommitRecord>());
  }

  // One past the last existing commit once discovered (a short page marks the end); Infinity until.
  get knownEnd() {
    return ref(Number.POSITIVE_INFINITY);
  }

  // Stale-supersession token — only the newest ensureRange may mutate state.
  private loadId = 0;

  get loadedCount(): number {
    return this.cache.value.size;
  }

  /** Records for `[start, start+count)`; `undefined` = not yet loaded (render a placeholder row). */
  rows(start: number, count: number): (CommitRecord | undefined)[] {
    const cachedRecords = this.cache.value; // subscribe
    const records: (CommitRecord | undefined)[] = [];
    for (let index = start; index < start + count; index++) {
      records.push(index >= 0 ? cachedRecords.get(index) : undefined);
    }
    return records;
  }

  /** Fetch one page `[skip, skip+limit)`. Overridable via constructor `fetch` (tests inject a fake). */
  protected async fetchPage(skip: number, limit: number): Promise<CommitRecord[]> {
    if (this.options.fetch) return this.options.fetch(skip, limit);
    const result = await GitCommands.Class.log({ cwd: this.cwd, branch: this.options.branch, skip, limit });
    if (result.code !== 0) return [];
    return GitParsers.Class.parseLog(result.stdout);
  }

  // invariant: Only the newest Git request mutates state (src/modules/git/git.invariants.md)
  /**
   * Ensure `[start, count)` is present: fetch only the missing contiguous ranges (batched, not one
   * call per row), evict cache entries outside the keep-margin, and — since a stale fetch is
   * discarded — never let an out-of-date page overwrite newer state.
   */
  async ensureRange(start: number, count: number, keepMargin = count): Promise<void> {
    const loadToken = ++this.loadId;
    const gaps = GitWindow.Class.missingRanges(new Set(this.cache.value.keys()), start, count);
    for (const { offset, length } of gaps) {
      const page = await this.fetchPage(offset, length);
      if (loadToken !== this.loadId) return; // superseded by a newer ensureRange — discard
      const next = new Map(this.cache.value);
      page.forEach((record, pageOffset) => next.set(offset + pageOffset, record));
      if (page.length < length) this.knownEnd.value = offset + page.length; // reached the end
      this.cache.value = next;
    }
    this.evict(start, count, keepMargin);
  }

  private evict(start: number, count: number, margin: number): void {
    const keepStart = Math.max(0, start - margin);
    const keepCount = count + margin * 2;
    const drop = GitWindow.Class.evictable(this.cache.value.keys(), keepStart, keepCount);
    if (drop.length === 0) return;
    const next = new Map(this.cache.value);
    for (const index of drop) next.delete(index);
    this.cache.value = next;
  }

  /** Drop everything (e.g. after a commit/refresh changes history). */
  reset(): void {
    this.loadId++;
    this.cache.value = new Map();
    this.knownEnd.value = Number.POSITIVE_INFINITY;
  }
}

export namespace CommitLog {
  export const $Class = $CommitLog;
  export let Class = Reactive($Class);
  export type Model = InstanceType<typeof Class>;
  export type Instance = typeof Class.Instance;
}
