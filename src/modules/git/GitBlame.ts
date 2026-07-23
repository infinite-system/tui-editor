// Current-line git blame (GitLens parity). Blaming a file is a git SPAWN, but a cursor move must be
// instant — so this capability blames a file ONCE, caches the per-line authorship map keyed on the
// file's on-disk mtime, and answers every subsequent line query as a pure map lookup. A save (mtime
// bump) invalidates the entry and triggers a re-blame; a non-tracked / non-repo file caches an empty
// map (a negative result) so it never re-spawns every frame. The async load bumps a reactive revision
// so the status bar repaints the instant the blame arrives.
//
// invariant: Current-line blame is a cached lookup, not a per-move git spawn (src/modules/git/git.invariants.md)
// invariant: An unblamable file degrades to no blame, never an error (src/modules/git/git.invariants.md)
import { Static } from 'ivue/extras';
import { ref } from 'vue';
import { Files } from '../system/Files';
import { GitCommands } from './GitCommands';

/** Authorship of ONE line: who last touched it, when, the commit summary, and its sha. `uncommitted` is
 *  true for a working-tree line git has not committed yet (the all-zero sha). */
export interface BlameLine {
  readonly sha: string;
  readonly author: string;
  readonly authorTimeMs: number;
  readonly summary: string;
  readonly uncommitted: boolean;
}

/** Query for the cursor line's blame. `lineNumber` is 0-based (the editor cursor line); `documentPath`
 *  is absolute; `isRepo` gates the spawn so a non-git workspace never shells out. */
export interface LineBlameQuery {
  readonly repoRoot: string;
  readonly isRepo: boolean;
  readonly documentPath: string;
  readonly lineNumber: number;
}

interface BlameCacheEntry {
  readonly mtimeMs: number;
  readonly lines: Map<number, BlameLine>; // keyed by 1-based final line number (git's numbering)
}

const UNCOMMITTED_SHA = '0000000000000000000000000000000000000000';
const HEADER = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;

// Module-level cache + in-flight guard + the reactive load signal. A completed load bumps `revision`,
// which the status bar reads, so blame appears without a keystroke and idle stays quiescent otherwise.
const blameCache = new Map<string, BlameCacheEntry>();
const inFlightPaths = new Set<string>();
const blameRevision = ref(0);

/** Parse `git blame --porcelain` into a 1-based line → BlameLine map. A commit's author/summary
 *  metadata is emitted only on its FIRST hunk, so it is remembered per sha and reused for later hunks. */
function parseBlamePorcelain(output: string): Map<number, BlameLine> {
  const shaMetadata = new Map<string, { author: string; authorTimeMs: number; summary: string }>();
  const result = new Map<number, BlameLine>();
  const rawLines = output.split('\n');
  let index = 0;
  while (index < rawLines.length) {
    const header = HEADER.exec(rawLines[index] ?? '');
    if (!header) {
      index += 1;
      continue;
    }
    const sha = header[1] as string;
    const finalLine = Number.parseInt(header[2] as string, 10);
    const metadata = shaMetadata.get(sha) ?? { author: '', authorTimeMs: 0, summary: '' };
    index += 1;
    // Consume this hunk's metadata lines up to the tab-prefixed content line. On a repeated sha there
    // are none (git omits already-sent metadata), so the cached metadata is reused unchanged.
    while (index < rawLines.length && !(rawLines[index] ?? '').startsWith('\t')) {
      const line = rawLines[index] as string;
      if (line.startsWith('author ')) metadata.author = line.slice('author '.length);
      else if (line.startsWith('author-time ')) metadata.authorTimeMs = Number.parseInt(line.slice('author-time '.length), 10) * 1000;
      else if (line.startsWith('summary ')) metadata.summary = line.slice('summary '.length);
      index += 1;
    }
    shaMetadata.set(sha, metadata);
    if (index < rawLines.length && (rawLines[index] ?? '').startsWith('\t')) index += 1; // skip content line
    const uncommitted = sha === UNCOMMITTED_SHA;
    result.set(finalLine, {
      sha,
      author: uncommitted ? 'You (uncommitted)' : metadata.author,
      authorTimeMs: metadata.authorTimeMs,
      summary: uncommitted ? 'Uncommitted changes' : metadata.summary,
      uncommitted,
    });
  }
  return result;
}

/** Blame `documentPath` once and cache the result under its current mtime. A nonzero exit (untracked /
 *  non-repo) caches an EMPTY map so the negative result is remembered and never re-spawned each frame. */
async function loadBlame(repoRoot: string, documentPath: string, mtimeMs: number): Promise<void> {
  if (inFlightPaths.has(documentPath)) return;
  inFlightPaths.add(documentPath);
  try {
    const result = await GitCommands.Class.blamePorcelain(repoRoot, documentPath);
    const lines = result.code === 0 ? parseBlamePorcelain(result.stdout) : new Map<number, BlameLine>();
    blameCache.set(documentPath, { mtimeMs, lines });
  } catch {
    blameCache.set(documentPath, { mtimeMs, lines: new Map() }); // any failure → no blame, cached
  } finally {
    inFlightPaths.delete(documentPath);
    blameRevision.value += 1; // repaint: the blame (or its absence) is now known
  }
}

class $GitBlame {
  /** The cursor line's blame, or null. Pure cache lookup when the file is already blamed at its current
   *  mtime; otherwise kicks a one-shot async load and returns null until it resolves (then the reactive
   *  revision repaints). Reading `revision` here makes the caller's render effect track load completion. */
  static lineBlame(query: LineBlameQuery): BlameLine | null {
    void blameRevision.value; // track: a completed load repaints whoever called this in a render effect
    if (!query.isRepo || !query.documentPath) return null;
    const mtimeMs = Files.Class.mtimeMs(query.documentPath);
    if (mtimeMs === 0) return null; // file not on disk (unsaved/untitled) → no blame
    const cached = blameCache.get(query.documentPath);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.lines.get(query.lineNumber + 1) ?? null; // cursor line is 0-based; git is 1-based
    }
    void loadBlame(query.repoRoot, query.documentPath, mtimeMs);
    return null;
  }

  /** Exposed for unit tests: the porcelain parser in isolation. */
  static parsePorcelain(output: string): Map<number, BlameLine> {
    return parseBlamePorcelain(output);
  }

  /** Drop all cached blame (e.g. on an explicit refresh). */
  static clearCache(): void {
    blameCache.clear();
    inFlightPaths.clear();
  }
}

export namespace GitBlame {
  export const $Class = $GitBlame;
  export const Class = Static($GitBlame);
}
