// PURE parsing for `git blame --porcelain` output. Stateless by design: the cache, the in-flight
// guard, the reactive load signal, and their lifecycle live in the workspace-owned
// `GitBlameCache` (a bounded, disposable Reactive instance) — a Static capability must never hide
// mutable module-level state behind its facade.
//
// invariant: An unblamable file degrades to no blame, never an error (src/modules/git/git.invariants.md)
import { Static } from 'ivue/extras';

/** Authorship of ONE line: who last touched it, when, the commit summary, and its sha. `uncommitted` is
 *  true for a working-tree line git has not committed yet (the all-zero sha). */
export interface BlameLine {
  readonly sha: string;
  readonly author: string;
  readonly authorTimeMs: number;
  readonly summary: string;
  readonly uncommitted: boolean;
}

const UNCOMMITTED_SHA = '0000000000000000000000000000000000000000';
const HEADER = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;

/** Parse `git blame --porcelain` into a 1-based line → BlameLine map. A commit's author/summary
 *  metadata is emitted only on its FIRST hunk, so it is remembered per sha and reused for later hunks. */
function $parsePorcelain(output: string): Map<number, BlameLine> {
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

class $GitBlame {
  static parsePorcelain = $parsePorcelain;
}

export namespace GitBlame {
  export const $Class = $GitBlame;
  export const Class = Static($GitBlame);
}
