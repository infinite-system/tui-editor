import { test, expect, describe } from 'bun:test';
import { GitPanel } from './GitPanel';

describe('GitPanel drill-down stack', () => {
  test('starts in the changes view', () => {
    const p = new GitPanel.Class();
    expect(p.view.value).toBe('changes');
    expect(p.activeCommit.value).toBeNull();
  });

  test('openCommit → commitFiles; openFile → fileDiff; back unwinds', () => {
    const p = new GitPanel.Class();
    p.openCommit('sha1', [
      { path: 'a.ts', status: 'M' },
      { path: 'b.ts', status: 'A' },
    ]);
    expect(p.view.value).toBe('commitFiles');
    expect(p.activeCommit.value).toBe('sha1');
    expect(p.commitFiles.value).toHaveLength(2);
    expect(p.commitFilesIndex.value).toBe(0);

    p.openFile('a.ts');
    expect(p.view.value).toBe('fileDiff');
    expect(p.activeFile.value).toBe('a.ts');

    p.back(); // fileDiff → commitFiles
    expect(p.view.value).toBe('commitFiles');
    expect(p.activeFile.value).toBeNull();
    expect(p.activeCommit.value).toBe('sha1'); // still in the commit

    p.back(); // commitFiles → changes
    expect(p.view.value).toBe('changes');
    expect(p.activeCommit.value).toBeNull();
    expect(p.commitFiles.value).toHaveLength(0);
  });

  test('back from changes is a no-op', () => {
    const p = new GitPanel.Class();
    p.back();
    expect(p.view.value).toBe('changes');
  });
});

describe('GitPanel split ratio', () => {
  test('clamps to [0.15, 0.85]', () => {
    const p = new GitPanel.Class();
    p.setSplit(0.5);
    expect(p.splitRatio.value).toBe(0.5);
    p.setSplit(-1);
    expect(p.splitRatio.value).toBe(0.15);
    p.setSplit(2);
    expect(p.splitRatio.value).toBe(0.85);
  });
});
