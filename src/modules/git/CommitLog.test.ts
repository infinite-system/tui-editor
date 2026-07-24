import { test, expect, describe } from 'bun:test';
import { CommitLog, type CommitPageFetch } from './CommitLog';
import type { CommitRecord } from './GitParsers';

function makeCommit(index: number): CommitRecord {
  return {
    sha: `sha${index}`,
    shortSha: `s${index}`,
    author: 'a',
    dateIso: '2026-01-01',
    subject: `commit ${index}`,
    refs: [],
  };
}

// A fake page fetch backed by a fixed total; records the (skip,limit) calls it received.
function fakeFetch(total: number, calls: Array<{ skip: number; limit: number }>): CommitPageFetch {
  return async (skip, limit) => {
    calls.push({ skip, limit });
    const records: CommitRecord[] = [];
    for (let index = skip; index < Math.min(skip + limit, total); index++) {
      records.push(makeCommit(index));
    }
    return records;
  };
}

describe('CommitLog', () => {
  test('ensureRange fills the window; rows returns loaded records', async () => {
    const calls: Array<{ skip: number; limit: number }> = [];
    const log = new CommitLog.Class('/repo', { fetch: fakeFetch(1000, calls) });
    await log.ensureRange(0, 10);
    const rows = log.rows(0, 10);
    expect(rows.every((row) => row !== undefined)).toBe(true);
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

  test('a FAILED fetch is not end-of-history: knownEnd stays put and a retry fills the rows', async () => {
    let failNext = true;
    const fetch: CommitPageFetch = async (skip, limit) => {
      if (failNext) return null; // command failure — NOT an empty page
      const records: CommitRecord[] = [];
      for (let index = skip; index < skip + limit; index++) records.push(makeCommit(index));
      return records;
    };
    const log = new CommitLog.Class('/repo', { fetch });
    await log.ensureRange(0, 5);
    // The failure must not have been cached as EOF (the empty-repository lie) — the rows stay
    // unloaded placeholders and the extent stays unknown.
    expect(log.knownEnd.value).toBe(Number.POSITIVE_INFINITY);
    expect(log.rows(0, 5)).toEqual([undefined, undefined, undefined, undefined, undefined]);

    failNext = false; // the transient failure clears (e.g. index lock released)
    await log.ensureRange(0, 5);
    expect(log.rows(0, 5).every((row) => row !== undefined)).toBe(true);
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

  test('setBranch re-sources the SAME pipeline: cache resets, fetch receives the new ref', async () => {
    const fetchedBranches: Array<string | undefined> = [];
    const fetch: CommitPageFetch = async (skip, limit, branch) => {
      fetchedBranches.push(branch);
      const records: CommitRecord[] = [];
      for (let index = skip; index < skip + limit; index++) {
        records.push({ ...makeCommit(index), subject: `${branch ?? 'HEAD'} ${index}` });
      }
      return records;
    };
    const log = new CommitLog.Class('/repo', { fetch });
    await log.ensureRange(0, 3);
    expect(log.rows(0, 1)[0]!.subject).toBe('HEAD 0');

    log.setBranch('feature');
    expect(log.rows(0, 3)).toEqual([undefined, undefined, undefined]); // cache dropped
    expect(log.knownEnd.value).toBe(Number.POSITIVE_INFINITY); // end re-discovered per ref
    await log.ensureRange(0, 3);
    expect(log.rows(0, 1)[0]!.subject).toBe('feature 0');
    expect(fetchedBranches).toEqual([undefined, 'feature']);

    log.setBranch('feature'); // same ref — a no-op, never a spurious reset
    expect(log.rows(0, 1)[0]).toBeDefined();

    log.setBranch(undefined); // back to following HEAD
    expect(log.rows(0, 1)[0]).toBeUndefined();
  });

  test('loadedTipSha is the displayed tip (cache index 0), null before the first page', async () => {
    const log = new CommitLog.Class('/repo', { fetch: fakeFetch(10, []) });
    expect(log.loadedTipSha).toBeNull();
    await log.ensureRange(0, 3);
    expect(log.loadedTipSha).toBe('sha0');
    log.reset();
    expect(log.loadedTipSha).toBeNull();
  });

  test('stale ensureRange is discarded (only the newest mutates state)', async () => {
    // A slow first fetch (resolves later) must NOT overwrite a newer fetch's result.
    let releaseSlow: (() => void) | null = null;
    const slow = new Promise<void>((resolve) => (releaseSlow = resolve));
    let call = 0;
    const fetch: CommitPageFetch = async (skip, limit) => {
      call++;
      if (call === 1) {
        await slow; // first call hangs until released
        return [{ ...makeCommit(999), subject: 'STALE' }];
      }
      const records: CommitRecord[] = [];
      for (let index = skip; index < skip + limit; index++) records.push(makeCommit(index));
      return records;
    };
    const log = new CommitLog.Class('/repo', { fetch });
    const first = log.ensureRange(0, 1); // starts the slow fetch
    await log.ensureRange(0, 1); // newer; completes immediately with commit 0
    releaseSlow!();
    await first; // stale resolves now — must be discarded
    expect(log.rows(0, 1)[0]!.subject).toBe('commit 0'); // NOT 'STALE'
  });
});
