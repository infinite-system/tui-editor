import { test, expect, describe } from 'bun:test';
import { CommitExpansion, type CommitFilesFetch } from './CommitExpansion';
import type { CommitFileChange } from './GitParsers';

function filesFor(sha: string): CommitFileChange[] {
  return [{ status: 'M', path: `${sha}/changed.ts` }];
}

/** A controllable fetch: records requested shas; resolves when the test releases it. */
function deferredFetch(calls: string[]): {
  fetch: CommitFilesFetch;
  release: (sha: string) => void;
} {
  const pending = new Map<string, (files: CommitFileChange[]) => void>();
  return {
    fetch: (sha) => {
      calls.push(sha);
      return new Promise((resolve) => pending.set(sha, resolve));
    },
    release: (sha) => {
      pending.get(sha)?.(filesFor(sha));
      pending.delete(sha);
    },
  };
}

const immediateFetch =
  (calls: string[]): CommitFilesFetch =>
  async (sha) => {
    calls.push(sha);
    return filesFor(sha);
  };

describe('CommitExpansion', () => {
  test('expand fetches lazily, ONLY the expanded sha, and files land in the entry', async () => {
    const calls: string[] = [];
    const expansion = new CommitExpansion.Class('/repo', { fetch: immediateFetch(calls) });
    await expansion.expand(3, 'sha3');
    expect(calls).toEqual(['sha3']); // never a pre-fetch of neighbors
    expect(expansion.entries.value).toEqual([
      { commitIndex: 3, sha: 'sha3', files: [{ status: 'M', path: 'sha3/changed.ts' }] },
    ]);
  });

  test('the loading state shows immediately (files null) until the fetch lands', async () => {
    const calls: string[] = [];
    const { fetch, release } = deferredFetch(calls);
    const expansion = new CommitExpansion.Class('/repo', { fetch });
    const expanding = expansion.expand(1, 'sha1');
    expect(expansion.entries.value).toEqual([{ commitIndex: 1, sha: 'sha1', files: null }]);
    release('sha1');
    await expanding;
    expect(expansion.entries.value[0]!.files).toEqual(filesFor('sha1'));
  });

  test('a collapse BEFORE the fetch returns discards the stale result', async () => {
    const calls: string[] = [];
    const { fetch, release } = deferredFetch(calls);
    const expansion = new CommitExpansion.Class('/repo', { fetch });
    const expanding = expansion.expand(1, 'sha1');
    expansion.collapse('sha1'); // user collapses while the fetch is in flight
    release('sha1');
    await expanding;
    expect(expansion.entries.value).toEqual([]); // the late result did NOT resurrect the entry
    expect(expansion.isExpanded('sha1')).toBe(false);
  });

  test('toggle expands then collapses (collapse evicts the cached files)', async () => {
    const calls: string[] = [];
    const expansion = new CommitExpansion.Class('/repo', { fetch: immediateFetch(calls) });
    expansion.toggle(2, 'sha2');
    await Bun.sleep(0);
    expect(expansion.isExpanded('sha2')).toBe(true);
    expansion.toggle(2, 'sha2');
    expect(expansion.entries.value).toEqual([]);
    // Re-expanding refetches (evict-on-collapse; lazy again).
    expansion.toggle(2, 'sha2');
    await Bun.sleep(0);
    expect(calls).toEqual(['sha2', 'sha2']);
  });

  test('expanding past the capacity collapses the OLDEST expansion (bounded cache)', async () => {
    const calls: string[] = [];
    const expansion = new CommitExpansion.Class('/repo', {
      fetch: immediateFetch(calls),
      capacity: 3,
    });
    for (let commitIndex = 0; commitIndex < 5; commitIndex++) {
      await expansion.expand(commitIndex, `sha${commitIndex}`);
    }
    expect(expansion.entries.value.length).toBe(3);
    expect(expansion.entries.value.map((entry) => entry.sha)).toEqual(['sha2', 'sha3', 'sha4']);
    expect(expansion.isExpanded('sha0')).toBe(false);
    expect(expansion.isExpanded('sha1')).toBe(false);
  });

  test('entries stay sorted by commitIndex regardless of expansion order', async () => {
    const calls: string[] = [];
    const expansion = new CommitExpansion.Class('/repo', { fetch: immediateFetch(calls) });
    await expansion.expand(7, 'sha7');
    await expansion.expand(2, 'sha2');
    await expansion.expand(5, 'sha5');
    expect(expansion.entries.value.map((entry) => entry.commitIndex)).toEqual([2, 5, 7]);
  });

  test('reset drops all expansions and makes in-flight fetches inert', async () => {
    const calls: string[] = [];
    const { fetch, release } = deferredFetch(calls);
    const expansion = new CommitExpansion.Class('/repo', { fetch });
    const expanding = expansion.expand(1, 'sha1');
    expansion.reset();
    release('sha1');
    await expanding;
    expect(expansion.entries.value).toEqual([]);
  });
});
