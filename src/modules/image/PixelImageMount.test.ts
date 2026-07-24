// PixelImageMount unit tests: the mount's discipline is what keeps graphics honest — emit only on a
// real key change (never per frame), emit only AFTER frames settle (the blanked cells land first),
// delete-before-replace, cancel superseded in-flight placements by generation, delete on clear, and
// sweep everything on dispose. A fake terminal captures payloads; a fake encoder makes them legible.
// invariant: A pixel tier places and deletes graphics explicitly (src/modules/image/image.invariants.md)
import { describe, test, expect } from 'bun:test';
import { PixelImageMount, type PixelMountContext, type PixelMountTerminal } from './PixelImageMount';
import type { PixelEncoder } from './ImageRenderers';
import type { DecodedImage } from './ImageDecoders';

function testImage(width: number, height: number): DecodedImage {
  return { width, height, rgba: new Uint8Array(width * height * 4).fill(128) };
}

/** A terminal whose settle promises are resolved manually, so tests control emission timing. */
function manualTerminal(): PixelMountTerminal & { written: string[]; settle(): Promise<void> } {
  const pendingSettles: Array<() => void> = [];
  return {
    written: [],
    writePayload(data: string) {
      this.written.push(data);
    },
    afterFramesSettled() {
      return new Promise<void>((resolve) => pendingSettles.push(resolve));
    },
    cellPixelSize: () => ({ width: 10, height: 20 }),
    async settle() {
      for (const resolve of pendingSettles.splice(0)) resolve();
      await Promise.resolve(); // let the .then continuations run
    },
  };
}

/** An encoder whose payloads are readable markers instead of escape bytes. */
const markerEncoder: PixelEncoder = {
  place: (context) => `PLACE[${context.imageId}:${context.columns}x${context.rows}]`,
  remove: (imageId) => `REMOVE[${imageId}]`,
  removeAll: () => 'REMOVE-ALL',
};

/** A paint-only encoder (sixel-shaped): cleanup encodes to nothing. */
const paintOnlyEncoder: PixelEncoder = {
  place: (context) => `PAINT[${context.pixelWidth}x${context.pixelHeight}]`,
  remove: () => '',
  removeAll: () => '',
};

function contextWith(overrides: Partial<PixelMountContext> = {}): PixelMountContext {
  return {
    tier: 'kitty',
    encoder: markerEncoder,
    image: testImage(100, 100),
    path: '/project/picture.png',
    region: { x: 30, y: 3, columns: 40, rows: 20 },
    panelBackground: '#1e1e2e',
    ...overrides,
  };
}

describe('PixelImageMount', () => {
  test('a placement is emitted once per key, after frames settle, positioned and cursor-bracketed', async () => {
    const terminal = manualTerminal();
    const mount = new PixelImageMount.Class(terminal);
    mount.sync(contextWith());
    expect(terminal.written.length).toBe(0); // nothing before the settle
    await terminal.settle();
    expect(terminal.written.length).toBe(1);
    const payload = terminal.written[0]!;
    // 100x100 into (40cells*10px)x(20cells*20px)=400x400px → fitted 400x400? No: fit min-scale=4 →
    // 400x400 clamped by box → 400x400 → 40x20 cells... height 400px/20px=20 rows. Centered at region.
    expect(payload).toContain('PLACE[7001:40x20]');
    expect(payload.startsWith('\x1b7\x1b[4;31H')).toBe(true); // CUP row 3+0+1, col 30+0+1
    expect(payload.endsWith('\x1b8')).toBe(true);
    // The same context again: NO new emission (the per-frame no-op).
    mount.sync(contextWith());
    await terminal.settle();
    expect(terminal.written.length).toBe(1);
  });

  test('a changed region re-places: delete-previous then place-new in one payload', async () => {
    const terminal = manualTerminal();
    const mount = new PixelImageMount.Class(terminal);
    mount.sync(contextWith());
    await terminal.settle();
    mount.sync(contextWith({ region: { x: 30, y: 3, columns: 20, rows: 10 } }));
    await terminal.settle();
    expect(terminal.written.length).toBe(2);
    const replacement = terminal.written[1]!;
    expect(replacement.indexOf('REMOVE[7001]')).toBeGreaterThanOrEqual(0);
    expect(replacement.indexOf('REMOVE[7001]')).toBeLessThan(replacement.indexOf('PLACE[7002:'));
  });

  test('a superseded in-flight placement is cancelled by generation — only the latest emits', async () => {
    const terminal = manualTerminal();
    const mount = new PixelImageMount.Class(terminal);
    mount.sync(contextWith());
    mount.sync(contextWith({ region: { x: 30, y: 3, columns: 20, rows: 10 } })); // before any settle
    await terminal.settle();
    expect(terminal.written.length).toBe(1);
    expect(terminal.written[0]!).toContain('PLACE[7002:');
    expect(terminal.written[0]!).not.toContain('PLACE[7001:');
  });

  test('clear deletes the placement immediately and cancels any pending place', async () => {
    const terminal = manualTerminal();
    const mount = new PixelImageMount.Class(terminal);
    mount.sync(contextWith());
    await terminal.settle();
    terminal.written.length = 0;
    mount.clear();
    expect(terminal.written).toEqual(['REMOVE[7001]']);
    mount.clear(); // idempotent: nothing placed, nothing written
    expect(terminal.written.length).toBe(1);
  });

  test('a paint-only tier clears silently (inert pixels need no delete payload)', async () => {
    const terminal = manualTerminal();
    const mount = new PixelImageMount.Class(terminal);
    mount.sync(contextWith({ tier: 'sixel', encoder: paintOnlyEncoder }));
    await terminal.settle();
    terminal.written.length = 0;
    mount.clear();
    expect(terminal.written.length).toBe(0);
  });

  test('dispose sweeps every identity-tracked placement (the quit guarantee)', async () => {
    const terminal = manualTerminal();
    const mount = new PixelImageMount.Class(terminal);
    mount.sync(contextWith());
    await terminal.settle();
    terminal.written.length = 0;
    mount.dispose();
    expect(terminal.written).toEqual(['REMOVE[7001]', 'REMOVE-ALL']);
    mount.dispose(); // idempotent
    expect(terminal.written.length).toBe(2);
  });

  test('REGRESSION (review correctness 2): clear during a queued replacement deletes the VISIBLE id', async () => {
    // 7001 is on screen; a replacement (7002) is queued but never settles; clear() must delete 7001 —
    // the pre-fix mount recorded 7002 as placed immediately and orphaned the visible 7001.
    const terminal = manualTerminal();
    const mount = new PixelImageMount.Class(terminal);
    mount.sync(contextWith());
    await terminal.settle(); // 7001 visible
    terminal.written.length = 0;
    mount.sync(contextWith({ region: { x: 30, y: 3, columns: 20, rows: 10 } })); // 7002 queued
    mount.clear(); // BEFORE the settle
    expect(terminal.written).toEqual(['REMOVE[7001]']);
    await terminal.settle(); // the cancelled 7002 payload must never write
    expect(terminal.written).toEqual(['REMOVE[7001]']);
  });

  test('the delete-previous half targets the emitted id even when a middle placement was cancelled', async () => {
    // 7001 visible → 7002 queued (never settles) → 7003 queued → settle: the payload must remove
    // 7001 (on screen), not 7002 (never placed).
    const terminal = manualTerminal();
    const mount = new PixelImageMount.Class(terminal);
    mount.sync(contextWith());
    await terminal.settle();
    terminal.written.length = 0;
    mount.sync(contextWith({ region: { x: 30, y: 3, columns: 20, rows: 10 } }));
    mount.sync(contextWith({ region: { x: 30, y: 3, columns: 10, rows: 5 } }));
    await terminal.settle();
    expect(terminal.written.length).toBe(1);
    expect(terminal.written[0]!).toContain('REMOVE[7001]');
    expect(terminal.written[0]!).toContain('PLACE[7003:');
    expect(terminal.written[0]!).not.toContain('7002');
  });

  test('REGRESSION (review correctness 13): a cell-size change with the same cell rect re-places', async () => {
    // A square image in a square cell region: cell 10x20 → 20x40 keeps the fitted CELL rect but
    // doubles the raster a pixel tier must emit — the key must include the fitted pixel dims.
    let cellSize = { width: 10, height: 20 };
    const terminal = manualTerminal();
    terminal.cellPixelSize = () => cellSize;
    const mount = new PixelImageMount.Class(terminal);
    const squareContext = () =>
      contextWith({
        tier: 'sixel',
        encoder: paintOnlyEncoder,
        image: testImage(1000, 1000),
        region: { x: 30, y: 3, columns: 10, rows: 10 },
      });
    mount.sync(squareContext());
    await terminal.settle();
    expect(terminal.written.length).toBe(1);
    expect(terminal.written[0]!).toContain('PAINT[100x100]'); // 10 cells * 10px wide limit... box 100x200 → fit 100x100
    cellSize = { width: 20, height: 40 };
    mount.sync(squareContext());
    await terminal.settle();
    expect(terminal.written.length).toBe(2);
    expect(terminal.written[1]!).toContain('PAINT[200x200]'); // same cells, doubled raster
  });

  test('the fitted rect letterboxes: a wide image in a tall region centres vertically', async () => {
    const terminal = manualTerminal();
    const mount = new PixelImageMount.Class(terminal);
    // 400x100 image into 40x20 cells at 10x20px → box 400x400px → fit 400x100px → 40x5 cells.
    mount.sync(contextWith({ image: testImage(400, 100) }));
    await terminal.settle();
    const payload = terminal.written[0]!;
    expect(payload).toContain('PLACE[7001:40x5]');
    // Vertical centring: offsetRows = floor((20-5)/2) = 7 → CUP row 3+7+1 = 11, col 30+0+1 = 31.
    expect(payload).toContain('\x1b[11;31H');
  });
});
