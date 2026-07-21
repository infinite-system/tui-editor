import { test, expect, describe } from 'bun:test';
import { OpenBufferSet, type LiveBuffer, type BufferPosition } from './OpenBufferSet';

// A fake live buffer: records dispose, carries a mutable dirty flag + position.
class FakeBuffer implements LiveBuffer {
  disposed = false;
  dirty = false;
  private position: BufferPosition = { cursorLine: 0, cursorColumn: 0, scrollTop: 0, scrollLeft: 0 };
  constructor(readonly path: string) {}
  openFile(): void {}
  snapshotPosition(): BufferPosition {
    return { ...this.position };
  }
  restorePosition(position: BufferPosition): void {
    this.position = { ...position };
  }
  setPosition(position: Partial<BufferPosition>): void {
    this.position = { ...this.position, ...position };
  }
}

function makeSet() {
  const created: FakeBuffer[] = [];
  const disposed: FakeBuffer[] = [];
  const set = new OpenBufferSet.Class({
    createBuffer: (path) => {
      const buffer = new FakeBuffer(path);
      created.push(buffer);
      return buffer;
    },
    disposeBuffer: (buffer) => {
      (buffer as FakeBuffer).disposed = true;
      disposed.push(buffer as FakeBuffer);
    },
  });
  return { set, created, disposed };
}

describe('open / focus', () => {
  test('opening adds tabs and activates; reopening focuses the existing tab', () => {
    const { set, created } = makeSet();
    set.open('a.ts');
    set.open('b.ts');
    set.open('c.ts');
    expect(set.count).toBe(3);
    expect(set.tabs().map((tab) => tab.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(set.tabs()[2]!.active).toBe(true);
    const index = set.open('a.ts'); // reopen -> focus the EXISTING tab (no new entry)
    expect(index).toBe(0);
    expect(set.count).toBe(3); // no duplicate tab
    expect(set.tabs()[0]!.active).toBe(true);
    void created;
  });
});

describe('flyweight: N tabs are NOT N live documents', () => {
  test('only the active buffer stays live; clean background tabs dehydrate + dispose', () => {
    const { set, created, disposed } = makeSet();
    for (const path of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']) set.open(path);
    // 5 tabs, but only ONE live document (the active) — the rest dehydrated on deactivation.
    expect(set.count).toBe(5);
    expect(set.liveCount).toBe(1);
    // Each deactivation disposed the outgoing clean buffer.
    expect(disposed.length).toBe(4);
    // Created: one per activation (they were disposed then would recreate if revisited).
    expect(created.length).toBe(5);
  });

  test('activation rehydrates and restores the saved position', () => {
    const { set, created } = makeSet();
    set.open('a.ts');
    (set.activeBuffer as FakeBuffer).setPosition({ cursorLine: 42, scrollTop: 30 });
    set.open('b.ts'); // deactivate a.ts -> snapshot + dispose
    expect(set.liveCount).toBe(1);
    set.activate(0); // rehydrate a.ts
    const rehydrated = created[created.length - 1] as FakeBuffer;
    expect(rehydrated.snapshotPosition().cursorLine).toBe(42);
    expect(rehydrated.snapshotPosition().scrollTop).toBe(30);
  });

  test('a DIRTY background buffer is retained (never dehydrated — edits must survive)', () => {
    const { set } = makeSet();
    set.open('a.ts');
    (set.activeBuffer as FakeBuffer).dirty = true;
    set.syncActiveDirty();
    set.open('b.ts'); // a.ts is dirty -> stays live
    expect(set.liveCount).toBe(2); // active b + dirty-retained a
    expect(set.tabs()[0]!.dirty).toBe(true);
  });
});

describe('close disposes', () => {
  test('closing a tab disposes its live buffer and activates a neighbour', () => {
    const { set, disposed } = makeSet();
    set.open('a.ts');
    set.open('b.ts');
    const activeBuffer = set.activeBuffer as FakeBuffer;
    set.close(1); // close active b
    expect(activeBuffer.disposed).toBe(true);
    expect(set.count).toBe(1);
    expect(set.tabs()[0]!.path).toBe('a.ts');
    expect(set.tabs()[0]!.active).toBe(true);
    expect(set.activeBuffer).not.toBeNull(); // neighbour rehydrated
    void disposed;
  });

  test('disposeAll releases every live buffer', () => {
    const { set } = makeSet();
    set.open('a.ts');
    (set.activeBuffer as FakeBuffer).dirty = true;
    set.syncActiveDirty();
    set.open('b.ts'); // now 2 live (dirty a + active b)
    expect(set.liveCount).toBe(2);
    set.disposeAll();
    expect(set.liveCount).toBe(0);
    expect(set.count).toBe(0);
  });
});

describe('cycle', () => {
  test('wraps forward and backward', () => {
    const { set } = makeSet();
    for (const path of ['a.ts', 'b.ts', 'c.ts']) set.open(path);
    expect(set.activeIndex.value).toBe(2);
    set.cycle(1); // wrap to 0
    expect(set.activeIndex.value).toBe(0);
    set.cycle(-1); // wrap to 2
    expect(set.activeIndex.value).toBe(2);
  });
});
