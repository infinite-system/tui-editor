// Workspace-OWNED blame cache (GitLens-parity current-line blame). Blaming a file is a git SPAWN,
// but a cursor move must be instant — so a file is blamed ONCE and its per-line authorship map is
// cached keyed on the file's on-disk mtime; every subsequent line query is a pure map lookup. A
// save (mtime bump) re-blames; an unblamable file (untracked / non-repo) caches an EMPTY map so
// the negative result never re-spawns per frame.
//
// Ownership and bounds (the restructure the review demanded): this is an instance the WORKSPACE
// creates for its root and disposes when the workspace suspends or closes — never module-level
// state hiding behind a Static facade. The cache is LRU-BOUNDED (a per-line map per file must
// track the actively observed set, not every file ever visited), and the on-disk stat is memoized
// for one paint tick so the status bar and the status publisher querying in the same frame cost
// one stat, not two.
//
// invariant: Current-line blame is a cached lookup, not a per-move git spawn (src/modules/git/git.invariants.md)
// invariant: An unblamable file degrades to no blame, never an error (src/modules/git/git.invariants.md)
// invariant: Cost tracks the actively observed set (project.invariants.md)
import { Reactive } from 'ivue';
import { ref } from 'vue';
import { Files } from '../system/Files';
import { GitCommands } from './GitCommands';
import { GitBlame, type BlameLine } from './GitBlame';

/** Most files whose full line-blame maps are retained at once; the least-recently-USED entry is
 *  evicted beyond this. Re-opening an evicted file simply re-blames it (one spawn). */
export const MAX_BLAMED_FILES = 16;

/** One paint tick: a second query for the same path within this window reuses the stat result. */
const STAT_MEMO_WINDOW_MILLISECONDS = 30;

interface BlameCacheEntry {
  readonly mtimeMs: number;
  readonly lines: ReadonlyMap<number, BlameLine>; // keyed by 1-based final line number (git's numbering)
}

export interface GitBlameCacheOptions {
  /** Injectable blame subprocess (tests): resolve porcelain stdout, or null for a nonzero exit. */
  blame?: (documentPath: string) => Promise<string | null>;
  /** Injectable mtime probe (tests): milliseconds, 0 = not on disk. */
  mtime?: (documentPath: string) => number;
}

class $GitBlameCache {
  constructor(
    readonly cwd: string,
    readonly options: GitBlameCacheOptions = {},
  ) {}

  /** Bumped when an async blame load lands (or fails) — a render effect reading lineBlame() tracks
   *  this, so blame appears the moment it is known and idle stays quiescent otherwise. */
  get revision() {
    return ref(0);
  }

  // LRU over insertion order: a hit re-inserts its key, so the FIRST key is always the coldest.
  private readonly cache = new Map<string, BlameCacheEntry>();
  private readonly inFlightPaths = new Set<string>();
  private disposed = false;
  // One stat per paint, not per query: the same (path) asked again inside the memo window reuses
  // the mtime — the status bar and the status side-channel both query during one frame.
  private statMemo: { documentPath: string; mtimeMs: number; checkedAtMs: number } | null = null;

  get cachedFileCount(): number {
    return this.cache.size;
  }

  /** The blame for one 0-based line of `documentPath`, or null. Pure cache lookup when the file is
   *  already blamed at its current mtime; otherwise kicks ONE async load and returns null until it
   *  resolves (the revision bump repaints the caller). */
  lineBlame(documentPath: string, lineNumber: number): BlameLine | null {
    void this.revision.value; // track: a completed load repaints whoever called this in a render effect
    if (this.disposed || !documentPath) return null;
    const mtimeMs = this.statMemoizedMtime(documentPath);
    if (mtimeMs === 0) return null; // file not on disk (unsaved/untitled) → no blame
    const cached = this.cache.get(documentPath);
    if (cached && cached.mtimeMs === mtimeMs) {
      this.refreshRecency(documentPath, cached);
      return cached.lines.get(lineNumber + 1) ?? null; // cursor line is 0-based; git is 1-based
    }
    void this.loadBlame(documentPath, mtimeMs);
    return null;
  }

  /** Drop every retained blame map and make any in-flight load inert. */
  dispose(): void {
    this.disposed = true;
    this.cache.clear();
    this.inFlightPaths.clear();
    this.statMemo = null;
  }

  private statMemoizedMtime(documentPath: string): number {
    const nowMs = Date.now();
    if (
      this.statMemo &&
      this.statMemo.documentPath === documentPath &&
      nowMs - this.statMemo.checkedAtMs < STAT_MEMO_WINDOW_MILLISECONDS
    ) {
      return this.statMemo.mtimeMs;
    }
    const mtimeMs = this.options.mtime ? this.options.mtime(documentPath) : Files.Class.mtimeMs(documentPath);
    this.statMemo = { documentPath, mtimeMs, checkedAtMs: nowMs };
    return mtimeMs;
  }

  /** LRU touch: re-insert so the map's first key stays the least-recently-used entry. */
  private refreshRecency(documentPath: string, entry: BlameCacheEntry): void {
    this.cache.delete(documentPath);
    this.cache.set(documentPath, entry);
  }

  private storeBounded(documentPath: string, entry: BlameCacheEntry): void {
    this.cache.delete(documentPath);
    this.cache.set(documentPath, entry);
    while (this.cache.size > MAX_BLAMED_FILES) {
      const coldestPath = this.cache.keys().next().value;
      if (coldestPath === undefined) break;
      this.cache.delete(coldestPath);
    }
  }

  /** Blame `documentPath` once and cache the result under its current mtime. A nonzero exit
   *  (untracked / non-repo) caches an EMPTY map so the negative result is remembered. */
  private async loadBlame(documentPath: string, mtimeMs: number): Promise<void> {
    if (this.inFlightPaths.has(documentPath)) return;
    this.inFlightPaths.add(documentPath);
    try {
      const porcelain = await this.runBlame(documentPath);
      if (this.disposed) return; // the workspace went cold while blaming — discard
      const lines = porcelain === null ? new Map<number, BlameLine>() : GitBlame.Class.parsePorcelain(porcelain);
      this.storeBounded(documentPath, { mtimeMs, lines });
    } catch {
      if (!this.disposed) this.storeBounded(documentPath, { mtimeMs, lines: new Map() }); // any failure → no blame, cached
    } finally {
      this.inFlightPaths.delete(documentPath);
      if (!this.disposed) this.revision.value += 1; // repaint: the blame (or its absence) is now known
    }
  }

  private async runBlame(documentPath: string): Promise<string | null> {
    if (this.options.blame) return this.options.blame(documentPath);
    const result = await GitCommands.Class.blamePorcelain(this.cwd, documentPath);
    return result.code === 0 ? result.stdout : null;
  }
}

export namespace GitBlameCache {
  export const $Class = $GitBlameCache;
  export let Class = Reactive($Class);
  export type Model = InstanceType<typeof Class>;
  export type Instance = typeof Class.Instance;
}
