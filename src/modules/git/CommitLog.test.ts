import { test, expect, describe } from 'bun:test';
import { CommitLog, type CommitPageFetch } from './CommitLog';
import type { CommitRecord } from './git.parsers';

function mkCommit(i: number): CommitRecord {
  return {
    sha: `sha${i}`,
    shortSha: `s${i}`,
    author: 'a',
    dateIso: '2026-01-01',
    subject: `commit ${i}`,
    refs: [],
  };
}

// A fake page fetch backed by a fixed total; records the (skip,limit) calls it received.
function fakeFetch(total: number, calls: Array<{ skip: number; limit: number }>): CommitPageFetch {
  return async (skip, limit) => {
    calls.push({ skip, limit });
    const out: CommitRecord[] = [];
    for (let i = skip; i < Math.min(skip + limit, total); i++) out.push(mkCommit(i));
    return out;
  };
}

describe('CommitLog', () => {
  test('ensureRange fills the window; rows returns loaded records', async () => {
    const calls: Array<{ skip: number; limit: number }> = [];
    const log = new CommitLog.Class('/repo', { fetch: fakeFetch(1000, calls) });
    await log.ensureRange(0, 10);
    const rows = log.rows(0, 10);
    expect(rows.every((r) => r !== undefined)).toBe(true);
    expect(rows[0]!.subject).toBe('commit 0');
    expect(rows[9]!.subject).toBe('commit 9');
    expect(calls).toEqual([{ skip: 0, limit: 10 }]); // one batched page
  });

  test('only missing ranges are fetched on re-ensure (no redundant refetch)', async () => {
    const calls: Array<{ skip: number; limit: number }> = [];
    const log = new CommitLog.Class('/repo', { fetch: fakeFetch(1000, calls), branch: undefined });
    await log.ensureRange(0, 10, 100); // keepMargin large so nothing evicted
    calls.length = 0;
    await log.ensureRange(5, 10, 100); // 5..14 : 5..9 cached, only 10..14 missing
    expect(calls).toEqual([{ skip: 10, limit: 5 }]);
  });

  test('rows returns undefined placeholders for unloaded indices', () => {
    const log = new CommitLog.Class('/repo', { fetch: fakeFetch(1000, []) });
    expect(log.rows(0, 3)).toEqual([undefined, undefined, undefined]);
  });

  test('a short page marks knownEnd (end of history)', async () => {
    const calls: Array<{ skip: number; limit: number }> = [];
    const log = new CommitLog.Class('/repo', { fetch: fakeFetch(7, calls) }); // only 7 commits
    await log.ensureRange(0, 20);
    expect(log.knownEnd.value).toBe(7);
    expect(log.rows(0, 20).filter(Boolean)).toHaveLength(7);
  });

  test('eviction bounds memory after scrolling far away', async () => {
    const log = new CommitLog.Class('/repo', { fetch: fakeFetch(10000, []) });
    await log.ensureRange(0, 10, 10); // load ~around 0
    await log.ensureRange(5000, 10, 10); // scroll far — near-0 pages should be evicted
    const near0 = log.rows(0, 10).filter(Boolean).length;
    const nearFar = log.rows(5000, 10).filter(Boolean).length;
    expect(nearFar).toBe(10); // current window loaded
    expect(near0).toBe(0); // far-away window evicted
    expect(log.loadedCount).toBeLessThan(60); // bounded, not 5010
  });

  test('stale ensureRange is discarded (only the newest mutates state)', async () => {
    // A slow first fetch (resolves later) must NOT overwrite a newer fetch's result.
    let releaseSlow: (() => void) | null = null;
    const slow = new Promise<void>((r) => (releaseSlow = r));
    let call = 0;
    const fetch: CommitPageFetch = async (skip, limit) => {
      call++;
      if (call === 1) {
        await slow; // first call hangs until released
        return [{ ...mkCommit(999), subject: 'STALE' }];
      }
      const out: CommitRecord[] = [];
      for (let i = skip; i < skip + limit; i++) out.push(mkCommit(i));
      return out;
    };
    const log = new CommitLog.Class('/repo', { fetch });
    const first = log.ensureRange(0, 1); // starts the slow fetch
    await log.ensureRange(0, 1); // newer; completes immediately with commit 0
    releaseSlow!();
    await first; // stale resolves now — must be discarded
    expect(log.rows(0, 1)[0]!.subject).toBe('commit 0'); // NOT 'STALE'
  });
});
