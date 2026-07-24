import { describe, expect, test } from 'bun:test';
import { SelectionDragBehavior, type SelectionDragPosition } from './SelectionDragBehavior';

function createBehavior(): {
  behavior: SelectionDragBehavior.Model;
  begun: SelectionDragPosition[];
  extended: SelectionDragPosition[];
  rowSteps: number[];
  columnSteps: number[];
  finished: { count: number };
} {
  const begun: SelectionDragPosition[] = [];
  const extended: SelectionDragPosition[] = [];
  const rowSteps: number[] = [];
  const columnSteps: number[] = [];
  const finished = { count: 0 };
  const behavior = new SelectionDragBehavior.Class({
    viewportRectangle: () => ({ leftColumn: 10, rightColumn: 19, topRow: 5, bottomRow: 14 }),
    positionAtCell: (screenColumn, screenRow) => ({ line: screenRow - 5, column: screenColumn - 10 }),
    horizontalScrollPosition: () => 3,
    horizontalScrollingEnabled: () => true,
    beginSelection: (position) => begun.push(position),
    extendSelection: (position) => extended.push(position),
    finishSelection: () => { finished.count += 1; },
    scrollColumns: (columnDelta) => columnSteps.push(columnDelta),
    scrollRows: (rowDelta) => rowSteps.push(rowDelta),
    haltCompetingScroll: () => {},
  });
  return { behavior, begun, extended, rowSteps, columnSteps, finished };
}

describe('SelectionDragBehavior', () => {
  test('one begin and every drag extend the host selection model', () => {
    const { behavior, begun, extended, finished } = createBehavior();
    behavior.begin(12, 7);
    behavior.drag(16, 10);
    behavior.end();
    expect(begun).toEqual([{ line: 2, column: 2 }]);
    expect(extended).toEqual([{ line: 5, column: 6 }]);
    expect(finished.count).toBe(1);
    expect(behavior.active).toBe(false);
  });

  test('a held edge integrates scroll steps and keeps extending in the advanced viewport', () => {
    const { behavior, extended, rowSteps, columnSteps } = createBehavior();
    behavior.begin(12, 7);
    behavior.drag(21, 16);
    expect(behavior.tick(0.2)).toBe(true);
    expect(rowSteps.some((step) => step > 0)).toBe(true);
    expect(columnSteps.some((step) => step > 0)).toBe(true);
    expect(extended.at(-1)).toEqual({ line: 9, column: 9 });
  });

  test('a pointer inside the edge zone does not keep the frame clock alive', () => {
    const { behavior } = createBehavior();
    behavior.begin(12, 7);
    behavior.drag(15, 9);
    expect(behavior.tick(0.2)).toBe(false);
  });
});
