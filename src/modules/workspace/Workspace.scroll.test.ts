import { test, expect, describe } from 'bun:test';
import { Workspace } from './Workspace';
import { CommitLog } from '../git/CommitLog';
import type { CommitRecord } from '../git/git.parsers';

function mk(i: number): CommitRecord {
  return { sha: `sha${i}`, shortSha: `s${i}`, author: 'a', dateIso: 'd', subject: `c${i}`, refs: [] };
}

describe('Workspace.scrollGitLog (window scroll, cost-tracks-observed-set)', () => {
  test('advances logScrollTop by delta and clamps at 0', () => {
    const ws = new Workspace.Class();
    // Inject a commit log with a fake fetch (no git); total is large.
    ws.commitLog.value = new CommitLog.Class('/r', {
      fetch: async (skip, limit) => Array.from({ length: limit }, (_, k) => mk(skip + k)),
    });
    ws.scrollGitLog(5);
    expect(ws.gitPanel.logScrollTop.value).toBe(5);
    ws.scrollGitLog(3);
    expect(ws.gitPanel.logScrollTop.value).toBe(8);
    ws.scrollGitLog(-100); // clamps
    expect(ws.gitPanel.logScrollTop.value).toBe(0);
  });

  test('clamps to knownEnd once a short page reveals the end', async () => {
    const ws = new Workspace.Class();
    const log = new CommitLog.Class('/r', {
      fetch: async (skip, limit) => {
        const out: CommitRecord[] = [];
        for (let i = skip; i < Math.min(skip + limit, 12); i++) out.push(mk(i)); // only 12 commits
        return out;
      },
    });
    ws.commitLog.value = log;
    await log.ensureRange(0, 50); // discovers knownEnd = 12
    expect(log.knownEnd.value).toBe(12);
    ws.scrollGitLog(1000); // try to scroll way past the end
    expect(ws.gitPanel.logScrollTop.value).toBe(11); // clamped to knownEnd - 1
  });

  test('scrolling only loads the observed window (never the whole log)', async () => {
    const ws = new Workspace.Class();
    ws.commitLog.value = new CommitLog.Class('/r', {
      fetch: async (skip, limit) => Array.from({ length: limit }, (_, k) => mk(skip + k)),
    });
    ws.scrollGitLog(200);
    // ensureRange(scrollTop=200, 50) is fired; wait a tick for the async fetch
    await new Promise((r) => setTimeout(r, 10));
    // loaded is bounded to ~the window, not 200+ — cost tracks the observed set.
    expect(ws.commitLog.value!.loadedCount).toBeLessThanOrEqual(60);
  });
});
