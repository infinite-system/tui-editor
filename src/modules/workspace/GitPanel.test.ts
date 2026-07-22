import { test, expect, describe } from 'bun:test';
import { GitPanel } from './GitPanel';

// The commit drill-down moved to the inline CommitExpansion model (git module) — its behavior is
// covered by CommitExpansion.test.ts and git.log-rows.test.ts.

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

describe('GitPanel multi-selection', () => {
  test('toggle, bulk-select, and clear are path-keyed and identity-replaced', () => {
    const panel = new GitPanel.Class();
    panel.toggleSelected('a.ts');
    panel.toggleSelected('b.ts');
    expect([...panel.selectedPaths.value].sort()).toEqual(['a.ts', 'b.ts']);
    panel.toggleSelected('a.ts');
    expect([...panel.selectedPaths.value]).toEqual(['b.ts']);
    panel.selectMany(['c.ts', 'd.ts']);
    expect(panel.selectedPaths.value.size).toBe(3);
    panel.clearSelectedPaths();
    expect(panel.selectedPaths.value.size).toBe(0);
  });
});

describe('GitPanel horizontal pane windows', () => {
  test('changes and log clamp independently to their own extents', () => {
    const panel = new GitPanel.Class();
    panel.setChangesHorizontalExtent(80, 20);
    panel.setLogHorizontalExtent(45, 30);

    panel.scrollChangesByColumns(10_000);
    panel.scrollLogByColumns(10_000);
    expect(panel.changesScrollLeft.value).toBe(60);
    expect(panel.logScrollLeft.value).toBe(15);

    panel.setChangesHorizontalExtent(10, 20);
    expect(panel.changesScrollLeft.value).toBe(0);
    expect(panel.logScrollLeft.value).toBe(15);
  });
});

describe('GitPanel persistent list selection', () => {
  test('click selection leaves both pane windows untouched', () => {
    const panel = new GitPanel.Class();
    panel.changesScrollTop.value = 8;
    panel.logScrollTop.value = 20;

    panel.setChangesSelection(11);
    panel.setLogSelection(24);

    expect(panel.changesIndex.value).toBe(11);
    expect(panel.logIndex.value).toBe(24);
    expect(panel.changesScrollTop.value).toBe(8);
    expect(panel.logScrollTop.value).toBe(20);
  });

  test('keyboard movement minimally reveals from the persistent selection', () => {
    const panel = new GitPanel.Class();
    panel.setVerticalViewportHeights(5, 6);
    panel.changesScrollTop.value = 10;
    panel.logScrollTop.value = 20;
    panel.setChangesSelection(12);
    panel.setLogSelection(23);

    panel.moveChangesSelection(15);
    panel.moveLogSelection(4, 100);

    expect(panel.changesIndex.value).toBe(15);
    expect(panel.changesScrollTop.value).toBe(11);
    expect(panel.logIndex.value).toBe(27);
    expect(panel.logScrollTop.value).toBe(22);

    panel.moveChangesSelection(9);
    panel.moveLogSelection(-10, 100);
    expect(panel.changesScrollTop.value).toBe(9);
    expect(panel.logScrollTop.value).toBe(17);
  });
});
