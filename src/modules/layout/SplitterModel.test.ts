import { test, expect, describe } from 'bun:test';
import { SplitterModel, type SplitterModelOptions } from './SplitterModel';

/** Build a model, recording every onSizeChange payload so tests can assert the persist seam. */
function makeSplitter(overrides: Partial<SplitterModelOptions> = {}): {
  splitter: SplitterModel.Instance;
  changes: number[];
} {
  const changes: number[] = [];
  const splitter = new SplitterModel.Class({
    orientation: 'vertical',
    initialSize: 30,
    minimumSize: 10,
    maximumSize: 50,
    onSizeChange: (size) => changes.push(size),
    ...overrides,
  });
  return { splitter, changes };
}

describe('SplitterModel — cells mode (sidebar-width divider)', () => {
  test('beginDrag + dragTo moves the size by the pointer delta', () => {
    const { splitter } = makeSplitter();
    splitter.beginDrag(100); // pointer anchored at x=100, size anchored at 30
    splitter.dragTo(112); // +12 cells to the right
    expect(splitter.size.value).toBe(42);
    splitter.dragTo(105); // delta is from the ANCHOR, not the previous move: +5
    expect(splitter.size.value).toBe(35);
  });

  test('dragging back to the left shrinks the pane', () => {
    const { splitter } = makeSplitter();
    splitter.beginDrag(100);
    splitter.dragTo(92); // -8
    expect(splitter.size.value).toBe(22);
  });

  test('clamps at the maximum', () => {
    const { splitter } = makeSplitter();
    splitter.beginDrag(100);
    splitter.dragTo(1000); // way past max
    expect(splitter.size.value).toBe(50);
  });

  test('clamps at the minimum', () => {
    const { splitter } = makeSplitter();
    splitter.beginDrag(100);
    splitter.dragTo(-1000); // way past min
    expect(splitter.size.value).toBe(10);
  });

  test('an out-of-range initialSize is clamped at construction', () => {
    const { splitter } = makeSplitter({ initialSize: 999 });
    expect(splitter.size.value).toBe(50);
  });
});

describe('SplitterModel — drag lifecycle', () => {
  test('dragTo before beginDrag is a no-op', () => {
    const { splitter, changes } = makeSplitter();
    splitter.dragTo(200);
    expect(splitter.size.value).toBe(30);
    expect(changes).toEqual([]);
  });

  test('endDrag stops tracking — later dragTo calls are ignored', () => {
    const { splitter } = makeSplitter();
    splitter.beginDrag(100);
    splitter.dragTo(110); // 40
    expect(splitter.dragging.value).toBe(true);
    splitter.endDrag();
    expect(splitter.dragging.value).toBe(false);
    splitter.dragTo(200); // ignored: no drag in progress
    expect(splitter.size.value).toBe(40);
  });

  test('a fresh drag re-anchors to the current size', () => {
    const { splitter } = makeSplitter();
    splitter.beginDrag(100);
    splitter.dragTo(110); // 40
    splitter.endDrag();
    splitter.beginDrag(0); // re-anchor at size 40, pointer 0
    splitter.dragTo(5); // +5 → 45
    expect(splitter.size.value).toBe(45);
  });
});

describe('SplitterModel — onSizeChange persist seam', () => {
  test('fires with the new size on every change', () => {
    const { splitter, changes } = makeSplitter();
    splitter.beginDrag(100);
    splitter.dragTo(110); // 40
    splitter.dragTo(105); // 35
    expect(changes).toEqual([40, 35]);
  });

  test('does not fire when the clamped size is unchanged', () => {
    const { splitter, changes } = makeSplitter();
    splitter.beginDrag(100);
    splitter.dragTo(1000); // clamps to 50
    splitter.dragTo(2000); // still 50 — no new notification
    expect(changes).toEqual([50]);
  });
});

describe('SplitterModel — ratio mode (git-split divider)', () => {
  const ratioOverrides: Partial<SplitterModelOptions> = {
    orientation: 'horizontal',
    mode: 'ratio',
    initialSize: 0.5,
    minimumSize: 0,
    maximumSize: 1,
    extentCells: 20, // 20 cells tall → each dragged cell is a 0.05 ratio step
  };

  test('a cell delta converts to a ratio delta through the extent', () => {
    const { splitter } = makeSplitter(ratioOverrides);
    splitter.beginDrag(10); // anchored at ratio 0.5, pointer y=10
    splitter.dragTo(14); // +4 cells → +0.20
    expect(splitter.size.value).toBeCloseTo(0.7, 10);
  });

  test('the ratio stays within zero and one under an extreme drag', () => {
    const { splitter } = makeSplitter(ratioOverrides);
    splitter.beginDrag(10);
    splitter.dragTo(1000); // far past the bottom
    expect(splitter.size.value).toBe(1);
    splitter.dragTo(-1000); // far past the top
    expect(splitter.size.value).toBe(0);
  });

  test('ratio never escapes [0,1] even with mis-configured bounds', () => {
    const { splitter } = makeSplitter({
      ...ratioOverrides,
      minimumSize: -5,
      maximumSize: 5,
    });
    splitter.beginDrag(10);
    splitter.dragTo(1000);
    expect(splitter.size.value).toBe(1);
    splitter.dragTo(-1000);
    expect(splitter.size.value).toBe(0);
  });

  test('setExtentCells recalibrates a ratio drag', () => {
    const { splitter } = makeSplitter(ratioOverrides);
    splitter.setExtentCells(10); // now each cell is a 0.10 ratio step
    splitter.beginDrag(0);
    splitter.dragTo(2); // +2 cells → +0.20
    expect(splitter.size.value).toBeCloseTo(0.7, 10);
  });
});
