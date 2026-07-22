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
