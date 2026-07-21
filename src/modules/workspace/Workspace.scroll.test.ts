import { test, expect, describe } from 'bun:test';
import { Workspace } from './Workspace';
import { CommitLog } from '../git/CommitLog';
import type { CommitRecord } from '../git/git.parsers';

function makeCommit(index: number): CommitRecord {
  return { sha: `sha${index}`, shortSha: `s${index}`, author: 'a', dateIso: 'd', subject: `c${index}`, refs: [] };
}

describe('Workspace.scrollGitLog (window scroll, cost-tracks-observed-set)', () => {
  test('advances logScrollTop by delta and clamps at 0', () => {
    const workspace = new Workspace.Class();
    // Inject a commit log with a fake fetch (no git); total is large.
    workspace.commitLog.value = new CommitLog.Class('/r', {
      fetch: async (skip, limit) => Array.from({ length: limit }, (_, index) => makeCommit(skip + index)),
    });
    workspace.scrollGitLog(5);
    expect(workspace.gitPanel.logScrollTop.value).toBe(5);
    workspace.scrollGitLog(3);
    expect(workspace.gitPanel.logScrollTop.value).toBe(8);
    workspace.scrollGitLog(-100); // clamps
    expect(workspace.gitPanel.logScrollTop.value).toBe(0);
  });

  test('clamps to knownEnd once a short page reveals the end', async () => {
    const workspace = new Workspace.Class();
    const commitLog = new CommitLog.Class('/r', {
      fetch: async (skip, limit) => {
        const records: CommitRecord[] = [];
        for (let index = skip; index < Math.min(skip + limit, 12); index++) records.push(makeCommit(index)); // only 12 commits
        return records;
      },
    });
    workspace.commitLog.value = commitLog;
    await commitLog.ensureRange(0, 50); // discovers knownEnd = 12
    expect(commitLog.knownEnd.value).toBe(12);
    workspace.scrollGitLog(1000); // try to scroll way past the end
    expect(workspace.gitPanel.logScrollTop.value).toBe(11); // clamped to knownEnd - 1
  });

  test('scrolling only loads the observed window (never the whole log)', async () => {
    const workspace = new Workspace.Class();
    workspace.commitLog.value = new CommitLog.Class('/r', {
      fetch: async (skip, limit) => Array.from({ length: limit }, (_, index) => makeCommit(skip + index)),
    });
    workspace.scrollGitLog(200);
    // ensureRange(scrollTop=200, 50) is fired; wait a tick for the async fetch
    await new Promise((resolve) => setTimeout(resolve, 10));
    // loaded is bounded to ~the window, not 200+ — cost tracks the observed set.
    expect(workspace.commitLog.value!.loadedCount).toBeLessThanOrEqual(60);
  });
});
