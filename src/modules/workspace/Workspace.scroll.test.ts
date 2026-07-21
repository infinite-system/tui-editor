import { test, expect, describe } from 'bun:test';
import { Workspace } from './Workspace';
import { CommitLog } from '../git/CommitLog';
import { GitRepository } from '../git/GitRepository';
import type { CommitRecord } from '../git/GitParsers';
import { mkdtempSync as makeTemporaryDirectorySync, rmSync as removeSync, writeFileSync } from 'node:fs';
import { tmpdir as temporaryDirectory } from 'node:os';
import { join } from 'node:path';

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

describe('Workspace.tickScrollAnimations', () => {
  test('advances every injected momentum state by whole cells and stays active while any glide moves', () => {
    const treeRoot = makeTemporaryDirectorySync(join(temporaryDirectory(), 'fable-momentum-tree-'));
    try {
      for (let fileNumber = 0; fileNumber < 12; fileNumber += 1) {
        writeFileSync(join(treeRoot, `file-${fileNumber}.txt`), `${fileNumber}`);
      }

      const workspace = new Workspace.Class();
      workspace.tree.open(treeRoot);
      workspace.editor.document.loadFromText(
        Array.from({ length: 20 }, (_, lineNumber) => `${lineNumber} ${'x'.repeat(38)}`).join('\n'),
      );
      workspace.editor.hasDocument.value = true;
      workspace.editor.viewport.setSize(10, 3);

      const gitRepository = new GitRepository.Class(treeRoot);
      gitRepository.untracked.value = Array.from({ length: 10 }, (_, fileNumber) => ({
        path: `change-${fileNumber}.txt`,
        xy: '??',
        x: '?',
        y: '?',
      }));
      workspace.git.value = gitRepository;
      workspace.commitLog.value = new CommitLog.Class(treeRoot, {
        fetch: async (startRecord, recordLimit) =>
          Array.from({ length: recordLimit }, (_, recordNumber) => makeCommit(startRecord + recordNumber)),
      });

      const injectedMomentum = { velocity: 20, residual: 0 };
      workspace.gitPanel.logMomentum.value = injectedMomentum;
      workspace.editor.viewport.verticalScrollMomentum.value = injectedMomentum;
      workspace.editor.viewport.horizontalScrollMomentum.value = injectedMomentum;
      workspace.tree.selectionMomentum.value = injectedMomentum;
      workspace.gitPanel.changesMomentum.value = injectedMomentum;

      expect(workspace.tickScrollAnimations(0.1)).toBe(true);
      expect(workspace.gitPanel.logScrollTop.value).toBe(2);
      expect(workspace.editor.viewport.scrollTop.value).toBe(2);
      expect(workspace.editor.viewport.scrollLeft.value).toBe(2);
      expect(workspace.tree.selectedIndex.value).toBe(2);
      expect(workspace.gitPanel.changesScrollTop.value).toBe(2);
    } finally {
      removeSync(treeRoot, { recursive: true, force: true });
    }
  });

  test('keeps requesting animation frames when velocity moves but no whole cell crosses', () => {
    const workspace = new Workspace.Class();
    workspace.editor.viewport.verticalScrollMomentum.value = { velocity: 4, residual: 0 };

    expect(workspace.tickScrollAnimations(0.001)).toBe(true);
    expect(workspace.editor.viewport.scrollTop.value).toBe(0);
    expect(workspace.editor.viewport.verticalScrollMomentum.value.residual).toBeGreaterThan(0);
  });

  test('clamps horizontal glide to visible lines and changes glide to its rendered window', () => {
    const workspace = new Workspace.Class();
    workspace.editor.document.loadFromText(
      ['x'.repeat(15), 'x'.repeat(25), 'x'.repeat(100)].join('\n'),
    );
    workspace.editor.hasDocument.value = true;
    workspace.editor.viewport.setSize(10, 2);

    const gitRepository = new GitRepository.Class('/unused');
    gitRepository.untracked.value = Array.from({ length: 10 }, (_, fileNumber) => ({
      path: `change-${fileNumber}.txt`,
      xy: '??',
      x: '?',
      y: '?',
    }));
    workspace.git.value = gitRepository;
    workspace.editor.viewport.horizontalScrollMomentum.value = { velocity: 80, residual: 0 };
    workspace.gitPanel.changesMomentum.value = { velocity: 80, residual: 0 };

    workspace.tickScrollAnimations(1);

    expect(workspace.editor.viewport.scrollLeft.value).toBe(15);
    expect(workspace.gitPanel.changesScrollTop.value).toBe(10);
  });

  test('precise editor, tree, and changes writers halt their injected momentum', () => {
    const workspace = new Workspace.Class();
    const injectedMomentum = { velocity: 40, residual: 0.5 };
    workspace.editor.viewport.verticalScrollMomentum.value = injectedMomentum;
    workspace.editor.viewport.horizontalScrollMomentum.value = injectedMomentum;
    workspace.tree.selectionMomentum.value = injectedMomentum;
    workspace.gitPanel.changesMomentum.value = injectedMomentum;

    workspace.editor.viewport.scrollToLine(0, 1);
    workspace.haltTreeScroll();
    workspace.haltGitChangesScroll();

    expect(workspace.editor.viewport.verticalScrollMomentum.value.velocity).toBe(0);
    expect(workspace.editor.viewport.horizontalScrollMomentum.value.velocity).toBe(0);
    expect(workspace.tree.selectionMomentum.value.velocity).toBe(0);
    expect(workspace.gitPanel.changesMomentum.value.velocity).toBe(0);
  });
});
