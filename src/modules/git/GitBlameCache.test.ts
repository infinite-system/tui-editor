// The workspace-owned blame cache: bounded LRU (blame memory tracks the actively observed set),
// mtime-keyed invalidation, negative caching, stat memoization within a paint tick, and disposal
// making in-flight loads inert. All through injected blame/mtime seams — no git, no filesystem.
import { test, expect, describe } from 'bun:test';
import { GitBlameCache, MAX_BLAMED_FILES } from './GitBlameCache';

const PORCELAIN_FOR = (author: string) =>
  [
    `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1`,
    `author ${author}`,
    'author-time 1700000000',
    'summary the change',
    '\tline body',
  ].join('\n');

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe('GitBlameCache', () => {
  test('blames once, then answers from the cache; a revision bump announces the load', async () => {
    let blameCalls = 0;
    const cache = new GitBlameCache.Class('/repo', {
      blame: async () => {
        blameCalls++;
        return PORCELAIN_FOR('Ada');
      },
      mtime: () => 111,
    });
    expect(cache.lineBlame('/repo/file.ts', 0)).toBeNull(); // kicks the async load
    await wait(1);
    expect(cache.revision.value).toBe(1);
    expect(cache.lineBlame('/repo/file.ts', 0)?.author).toBe('Ada');
    cache.lineBlame('/repo/file.ts', 0);
    expect(blameCalls).toBe(1); // pure lookups after the one spawn
  });

  test('an mtime change invalidates and re-blames; a failed blame caches an EMPTY map (negative)', async () => {
    let blameCalls = 0;
    let currentMtime = 1;
    let succeed = true;
    const cache = new GitBlameCache.Class('/repo', {
      blame: async () => {
        blameCalls++;
        return succeed ? PORCELAIN_FOR('Ada') : null;
      },
      mtime: () => currentMtime,
    });
    cache.lineBlame('/repo/file.ts', 0);
    await wait(1);
    expect(cache.lineBlame('/repo/file.ts', 0)?.author).toBe('Ada');

    await wait(31); // step past the stat-memo window so the new mtime is observed
    currentMtime = 2; // the file was saved
    succeed = false; // and became unblamable (e.g. left the index)
    cache.lineBlame('/repo/file.ts', 0); // re-kicks a load for the new mtime
    await wait(1);
    expect(blameCalls).toBe(2);
    expect(cache.lineBlame('/repo/file.ts', 0)).toBeNull(); // negative result
    cache.lineBlame('/repo/file.ts', 0);
    expect(blameCalls).toBe(2); // the negative result is CACHED — no per-frame respawn
  });

  test('the cache is LRU-bounded: old files are evicted, never process-lifetime growth', async () => {
    const cache = new GitBlameCache.Class('/repo', {
      blame: async () => PORCELAIN_FOR('Ada'),
      mtime: () => 1,
    });
    for (let fileIndex = 0; fileIndex < MAX_BLAMED_FILES + 5; fileIndex++) {
      cache.lineBlame(`/repo/file-${fileIndex}.ts`, 0);
      await wait(1);
    }
    expect(cache.cachedFileCount).toBeLessThanOrEqual(MAX_BLAMED_FILES);
  });

  test('the stat probe is memoized within a paint tick (two same-frame queries, one stat)', async () => {
    let statCalls = 0;
    const cache = new GitBlameCache.Class('/repo', {
      blame: async () => PORCELAIN_FOR('Ada'),
      mtime: () => {
        statCalls++;
        return 1;
      },
    });
    cache.lineBlame('/repo/file.ts', 0);
    await wait(31); // step past the memo window left by the load query
    statCalls = 0;
    cache.lineBlame('/repo/file.ts', 3); // the status bar's query…
    cache.lineBlame('/repo/file.ts', 3); // …and the status side-channel's, same frame
    expect(statCalls).toBe(1);
  });

  test('disposal drops the maps and makes an in-flight load inert', async () => {
    let releaseBlame: ((porcelain: string) => void) | null = null;
    const cache = new GitBlameCache.Class('/repo', {
      blame: () => new Promise<string | null>((resolve) => (releaseBlame = resolve)),
      mtime: () => 1,
    });
    cache.lineBlame('/repo/file.ts', 0); // load starts and hangs
    cache.dispose();
    releaseBlame!(PORCELAIN_FOR('Ada')); // lands AFTER disposal — must be discarded
    await wait(1);
    expect(cache.cachedFileCount).toBe(0);
    expect(cache.revision.value).toBe(0); // no zombie repaint signal either
    expect(cache.lineBlame('/repo/file.ts', 0)).toBeNull(); // disposed cache answers null, spawns nothing
  });
});
