import { test, expect, describe } from 'bun:test';
import { FrameProbe } from './FrameProbe';

// A minimal stand-in for OpenTUI's currentRenderBuffer. Matches the real memory layout:
// char/attributes are 1 lane per cell; fg/bg are FOUR Uint16 lanes (r,g,b,a) per cell.
function fakeRenderer(
  width: number,
  height: number,
  cells: { x: number; y: number; character: string; bg?: [number, number, number, number] }[],
) {
  const size = width * height;
  const char = new Uint32Array(size);
  const fg = new Uint16Array(size * 4);
  const bg = new Uint16Array(size * 4);
  const attributes = new Uint32Array(size);
  for (const cellSpec of cells) {
    const cell = cellSpec.y * width + cellSpec.x;
    char[cell] = cellSpec.character.codePointAt(0) ?? 0;
    if (cellSpec.bg) bg.set(cellSpec.bg, cell * 4);
  }
  return { currentRenderBuffer: { width, height, buffers: { char, fg, bg, attributes } } };
}

describe('FrameProbe.read', () => {
  test('reconstructs text and decodes bg as 4 RGBA lanes per cell', () => {
    const renderer = fakeRenderer(4, 2, [
      { x: 0, y: 0, character: 'h', bg: [0, 0, 0, 0] },
      { x: 1, y: 0, character: 'i', bg: [69, 71, 90, 255] }, // a real selection-ish colour
      { x: 0, y: 1, character: 'x' },
    ]);
    const dump = FrameProbe.Class.read(renderer);
    expect(dump.width).toBe(4);
    expect(dump.height).toBe(2);
    expect(dump.rows[0]!.text).toBe('hi'); // trailing blanks trimmed
    expect(dump.rows[0]!.bg[0]).toBe('0,0,0,0');
    expect(dump.rows[0]!.bg[1]).toBe('69,71,90,255'); // 4 lanes, not a single value
    expect(dump.rows[1]!.text).toBe('x');
  });

  test('a bg change is detected on the correct cell (no stride aliasing)', () => {
    // Regression for the stride bug: reading bg with stride 1 aliased one cell's change across
    // four, producing phantom period-4 groups. With the 4-lane layout, exactly cell (2,0) differs.
    const rendererA = fakeRenderer(6, 1, [{ x: 2, y: 0, character: 'a', bg: [0, 0, 0, 0] }]);
    const rendererB = fakeRenderer(6, 1, [{ x: 2, y: 0, character: 'a', bg: [69, 71, 90, 255] }]);
    const backgroundA = FrameProbe.Class.read(rendererA).rows[0]!.bg;
    const backgroundB = FrameProbe.Class.read(rendererB).rows[0]!.bg;
    const changed = backgroundA.map((value, index) => (value !== backgroundB[index] ? index : -1)).filter((index) => index >= 0);
    expect(changed).toEqual([2]); // one cell, not four
  });

  test('masks packed metadata in high bits to the codepoint (never throws)', () => {
    const width = 2;
    const char = new Uint32Array(width);
    char[0] = 0x41 | (2 << 21); // 'A' with width metadata above bit 21
    char[1] = 0;
    const renderer = {
      currentRenderBuffer: {
        width,
        height: 1,
        buffers: {
          char,
          fg: new Uint16Array(width * 4),
          bg: new Uint16Array(width * 4),
          attributes: new Uint32Array(width),
        },
      },
    };
    expect(() => FrameProbe.Class.read(renderer)).not.toThrow();
    expect(FrameProbe.Class.read(renderer).rows[0]!.text).toBe('A');
  });
});
