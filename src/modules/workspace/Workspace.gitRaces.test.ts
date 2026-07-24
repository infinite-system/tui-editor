// The two async-supersession races the correctness review caught (findings 11 + 12): a stale
// branch-tip probe must never override a newly selected branch, and overlapping diff opens must
// apply in CLICK order, not completion order. Both are driven through the real Workspace with the
// GitCommands capability swapped for controllable fakes (the `let Class` swap seam).
import { test, expect, describe, afterEach } from 'bun:test';
import { Workspace } from './Workspace';
import { CommitLog } from '../git/CommitLog';
import { GitRepository } from '../git/GitRepository';
import { GitCommands, type GitCommandResult } from '../git/GitCommands';
import type { CommitRecord } from '../git/GitParsers';

function makeCommit(index: number, branch: string): CommitRecord {
  return {
    sha: `${branch}-sha${index}`,
    shortSha: `s${index}`,
    author: 'a',
    dateIso: 'd',
    subject: `${branch} ${index}`,
    refs: [],
  };
}

function commandResult(code: number, stdout = ''): GitCommandResult {
  return { code, stdout, stderr: '' };
}

const originalGitCommandsClass = GitCommands.Class;
afterEach(() => {
  GitCommands.Class = originalGitCommandsClass;
});

/** A workspace wired for the branch viewer: injected commit log (fake fetch) + a repository whose
 *  head/branch refs are set directly (no subprocess), sidebar on the git view. */
function makeViewerWorkspace(): Workspace.Instance {
  const workspace = new Workspace.Class();
  workspace.commitLog.value = new CommitLog.Class('/repo', {
    fetch: async (skip, limit, branch) =>
      Array.from({ length: limit }, (_unused, index) => makeCommit(skip + index, branch ?? 'HEAD')),
  });
  workspace.git.value = new GitRepository.Class('/repo');
  workspace.git.value.branch.value = 'main';
  workspace.git.value.head.value = 'main-tip';
  workspace.sidebarView.value = 'git';
  return workspace;
}

describe('reconcileLogTip supersession (a stale probe never overrides the viewer)', () => {
  test('a late rev-parse FAILURE for the previously viewed branch does not force the new branch back to HEAD', async () => {
    const workspace = makeViewerWorkspace();
    let releaseProbe: ((result: GitCommandResult) => void) | null = null;
    GitCommands.Class = {
      ...originalGitCommandsClass,
      revParse: (_cwd: string, ref: string) => {
        if (ref === 'refs/heads/branch-a') {
          return new Promise<GitCommandResult>((resolve) => (releaseProbe = resolve));
        }
        return Promise.resolve(commandResult(0, `${ref}-tip\n`));
      },
    } as typeof GitCommands.Class;

    workspace.selectLogBranch('branch-a');
    const probePromise = workspace.reconcileLogTip(); // hangs awaiting rev-parse branch-a
    workspace.selectLogBranch('branch-b'); // the user moves on while the probe sleeps
    releaseProbe!(commandResult(128)); // branch-a vanished — the STALE probe reports failure
    await probePromise;

    expect(workspace.commitLog.value!.branch.value).toBe('branch-b'); // NOT forced back to HEAD
  });

  test('a late rev-parse SUCCESS for the previously viewed branch does not reset the new branch cache', async () => {
    const workspace = makeViewerWorkspace();
    let releaseProbe: ((result: GitCommandResult) => void) | null = null;
    GitCommands.Class = {
      ...originalGitCommandsClass,
      revParse: (_cwd: string, ref: string) => {
        if (ref === 'refs/heads/branch-a') {
          return new Promise<GitCommandResult>((resolve) => (releaseProbe = resolve));
        }
        return Promise.resolve(commandResult(0, `${ref}-tip\n`));
      },
    } as typeof GitCommands.Class;

    workspace.selectLogBranch('branch-a');
    const probePromise = workspace.reconcileLogTip();
    workspace.selectLogBranch('branch-b');
    const commitLog = workspace.commitLog.value!;
    await commitLog.ensureRange(0, 3); // branch-b's window loads
    expect(commitLog.rows(0, 1)[0]!.subject).toBe('branch-b 0');

    releaseProbe!(commandResult(0, 'branch-a-moved-tip\n')); // stale tip differs from the loaded one
    await probePromise;

    // The stale mismatch must NOT have reset branch-b's freshly loaded cache.
    expect(commitLog.rows(0, 1)[0]).toBeDefined();
    expect(commitLog.rows(0, 1)[0]!.subject).toBe('branch-b 0');
  });
});

describe('diff-open ordering (newest click wins, not newest completion)', () => {
  test('a slow older commit-file diff cannot overwrite a faster newer one', async () => {
    const workspace = new Workspace.Class();
    const pendingByRef = new Map<string, (result: GitCommandResult) => void>();
    GitCommands.Class = {
      ...originalGitCommandsClass,
      fileAtRef: (_cwd: string, ref: string, filePath: string) =>
        new Promise<GitCommandResult>((resolve) => pendingByRef.set(`${ref}:${filePath}`, resolve)),
    } as typeof GitCommands.Class;

    const slowOpen = workspace.openCommitFileDiff('slowsha', 'slow.ts');
    const fastOpen = workspace.openCommitFileDiff('fastsha', 'fast.ts');

    // Each diff awaits its refs SEQUENTIALLY (parent side, then commit side) — release a pending
    // ref as soon as the workspace requests it, until the awaited open settles.
    const releaseWhenRequested = async (ref: string, stdout: string): Promise<void> => {
      while (!pendingByRef.has(ref)) await Promise.resolve();
      pendingByRef.get(ref)!(commandResult(0, stdout));
      pendingByRef.delete(ref);
    };

    // The FAST (newer) diff resolves first and applies.
    await releaseWhenRequested('fastsha^:fast.ts', 'fast previous');
    await releaseWhenRequested('fastsha:fast.ts', 'fast current');
    await fastOpen;
    expect(workspace.diffRequest.value?.currentVersionPath).toBe('fast.ts');

    // The SLOW (older) diff resolves later — it must be discarded, not applied.
    await releaseWhenRequested('slowsha^:slow.ts', 'slow previous');
    await releaseWhenRequested('slowsha:slow.ts', 'slow current');
    await slowOpen;
    expect(workspace.diffRequest.value?.currentVersionPath).toBe('fast.ts'); // still the newest CLICK
    expect(workspace.diffRequest.value?.currentVersionText).toBe('fast current');
  });
});
