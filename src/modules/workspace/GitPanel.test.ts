import { test, expect, describe } from 'bun:test';
import { GitPanel } from './GitPanel';

describe('GitPanel drill-down stack', () => {
  test('starts in the changes view', () => {
    const panel = new GitPanel.Class();
    expect(panel.view.value).toBe('changes');
    expect(panel.activeCommit.value).toBeNull();
  });

  test('openCommit → commitFiles; openFile → fileDiff; back unwinds', () => {
    const panel = new GitPanel.Class();
    panel.openCommit('sha1', [
      { path: 'a.ts', status: 'M' },
      { path: 'b.ts', status: 'A' },
    ]);
    expect(panel.view.value).toBe('commitFiles');
    expect(panel.activeCommit.value).toBe('sha1');
    expect(panel.commitFiles.value).toHaveLength(2);
    expect(panel.commitFilesIndex.value).toBe(0);

    panel.openFile('a.ts');
    expect(panel.view.value).toBe('fileDiff');
    expect(panel.activeFile.value).toBe('a.ts');

    panel.back(); // fileDiff → commitFiles
    expect(panel.view.value).toBe('commitFiles');
    expect(panel.activeFile.value).toBeNull();
    expect(panel.activeCommit.value).toBe('sha1'); // still in the commit

    panel.back(); // commitFiles → changes
    expect(panel.view.value).toBe('changes');
    expect(panel.activeCommit.value).toBeNull();
    expect(panel.commitFiles.value).toHaveLength(0);
  });

  test('back from changes is a no-op', () => {
    const panel = new GitPanel.Class();
    panel.back();
    expect(panel.view.value).toBe('changes');
  });
});

describe('GitPanel split ratio', () => {
  test('clamps to [0.15, 0.85]', () => {
    const panel = new GitPanel.Class();
    panel.setSplit(0.5);
    expect(panel.splitRatio.value).toBe(0.5);
    panel.setSplit(-1);
    expect(panel.splitRatio.value).toBe(0.15);
    panel.setSplit(2);
    expect(panel.splitRatio.value).toBe(0.85);
  });
});
