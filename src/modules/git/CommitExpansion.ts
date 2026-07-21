// Inline commit expansion state for the commit log: WHICH commits are expanded and their lazily
// fetched changed-file lists. Fetching happens only on expand (`git show --name-status` for that
// one sha — never a pre-fetch of neighbors), the expanded set is hard-bounded (expanding past the
// capacity collapses the oldest expansion, which is also the cache eviction — cost tracks the
// observed set), and collapse discards an in-flight fetch (stale-superseded, per-sha tickets).
//
// The fetch is injectable (constructor `fetch`) so the expansion/eviction/supersession logic is
// unit-testable with no git; the default shells out via GitCommands + parseNameStatus.
//
// invariant: Commit expansion is lazy and windowed (src/modules/git/git.invariants.md)
// invariant: Only the newest Git request mutates state (src/modules/git/git.invariants.md)
// invariant: Cost tracks the actively observed set (project.invariants.md)
import { Reactive } from 'ivue';
import { shallowRef } from 'vue';
import { GitCommands } from './GitCommands';
import { GitParsers, type CommitFileChange } from './GitParsers';
import type { ExpandedCommit } from './GitLogRows';

export type CommitFilesFetch = (sha: string) => Promise<readonly CommitFileChange[]>;

export interface CommitExpansionOptions {
  fetch?: CommitFilesFetch;
  /** Most commits expanded (and cached) at once; expanding beyond collapses the oldest. */
  capacity?: number;
}

export const DEFAULT_EXPANSION_CAPACITY = 32;

class $CommitExpansion {
  constructor(
    readonly cwd: string,
    readonly options: CommitExpansionOptions = {},
  ) {}

  // Late-read dependency (never snapshot at construction).
  protected get GitCommands() {
    return GitCommands.Class;
  }

  /** Expanded commits sorted by commitIndex; `files` is null while the lazy fetch is in flight.
   *  Identity-replaced on every change so observers re-run. */
  get entries() {
    return shallowRef<readonly ExpandedCommit[]>([]);
  }

  /** Expansion order, oldest first — the bounded-eviction queue. */
  private expansionOrder: string[] = [];
  /** Per-sha stale-supersession tickets: a collapse (or re-expand) invalidates an in-flight fetch. */
  private fetchTickets = new Map<string, number>();
  private nextTicket = 0;

  get capacity(): number {
    return this.options.capacity ?? DEFAULT_EXPANSION_CAPACITY;
  }

  isExpanded(sha: string): boolean {
    return this.entries.value.some((entry) => entry.sha === sha);
  }

  /** Expand a collapsed commit / collapse an expanded one (click or Enter on its header row). */
  toggle(commitIndex: number, sha: string): void {
    if (this.isExpanded(sha)) this.collapse(sha);
    else void this.expand(commitIndex, sha);
  }

  /**
   * Expand ONE commit: show the loading row immediately, fetch its file list lazily, and apply the
   * result only if this expansion is still current (a collapse before the fetch lands discards it).
   * Expanding past the capacity collapses the oldest expansion first (bounded cache).
   */
  async expand(commitIndex: number, sha: string): Promise<void> {
    if (this.isExpanded(sha)) return;
    while (this.expansionOrder.length >= this.capacity) {
      const oldest = this.expansionOrder[0];
      if (oldest === undefined) break;
      this.collapse(oldest);
    }
    this.expansionOrder.push(sha);
    this.setEntry({ commitIndex, sha, files: null });
    const ticket = ++this.nextTicket;
    this.fetchTickets.set(sha, ticket);
    const files = await this.fetchFiles(sha);
    if (this.fetchTickets.get(sha) !== ticket) return; // collapsed/superseded meanwhile — discard
    this.fetchTickets.delete(sha);
    this.setEntry({ commitIndex, sha, files });
  }

  /** Collapse: drop the entry AND its cached files (evict on collapse — re-expanding refetches). */
  collapse(sha: string): void {
    this.fetchTickets.delete(sha);
    this.expansionOrder = this.expansionOrder.filter((expandedSha) => expandedSha !== sha);
    if (this.isExpanded(sha)) {
      this.entries.value = this.entries.value.filter((entry) => entry.sha !== sha);
    }
  }

  /** Drop everything (history changed / repository reset). In-flight fetches become inert. */
  reset(): void {
    this.fetchTickets.clear();
    this.expansionOrder = [];
    if (this.entries.value.length > 0) this.entries.value = [];
  }

  private setEntry(entry: ExpandedCommit): void {
    const next = this.entries.value.filter((existing) => existing.sha !== entry.sha);
    next.push(entry);
    next.sort((first, second) => first.commitIndex - second.commitIndex);
    this.entries.value = next;
  }

  /** Overridable via constructor `fetch` (tests inject a fake). Failures degrade to an empty list
   *  (the commit shows expanded with no file rows — never a thrown error). */
  protected async fetchFiles(sha: string): Promise<readonly CommitFileChange[]> {
    if (this.options.fetch) return this.options.fetch(sha);
    const result = await this.GitCommands.showNameStatus(this.cwd, sha);
    if (result.code !== 0) return [];
    return GitParsers.Class.parseNameStatus(result.stdout);
  }
}

export namespace CommitExpansion {
  export const $Class = $CommitExpansion;
  export let Class = Reactive($Class);
  export type Model = InstanceType<typeof Class>;
  export type Instance = typeof Class.Instance;
}
