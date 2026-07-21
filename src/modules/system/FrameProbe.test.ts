import { test, expect, describe } from 'bun:test';
import { FrameProbe } from './FrameProbe';

// A minimal stand-in for OpenTUI's currentRenderBuffer: row-major typed arrays.
function fakeRenderer(width: number, height: number, cells: { x: number; y: number; ch: string; bg: number }[]) {
  const char = new Uint32Array(width * height);
  const fg = new Uint16Array(width * height);
  const bg = new Uint16Array(width * height);
  const attributes = new Uint32Array(width * height);
  for (const c of cells) {
    const i = c.y * width + c.x;
    char[i] = c.ch.codePointAt(0) ?? 0;
    bg[i] = c.bg;
  }
  return { currentRenderBuffer: { width, height, buffers: { char, fg, bg, attributes } } };
}

describe('FrameProbe.read', () => {
  test('reconstructs text and bg per row from the buffer', () => {
    const r = fakeRenderer(4, 2, [
      { x: 0, y: 0, ch: 'h', bg: 0 },
      { x: 1, y: 0, ch: 'i', bg: 7 },
      { x: 0, y: 1, ch: 'x', bg: 0 },
    ]);
    const dump = FrameProbe.Class.read(r);
    expect(dump.width).toBe(4);
    expect(dump.height).toBe(2);
    expect(dump.rows[0]!.text).toBe('hi'); // trailing blanks trimmed
    expect(dump.rows[0]!.bg[1]).toBe(7);
    expect(dump.rows[1]!.text).toBe('x');
  });

  test('masks packed metadata in high bits to the codepoint (never throws)', () => {
    // Real buffers pack glyph width in high bits; the codepoint is the low 21 bits.
    const width = 2;
    const char = new Uint32Array(width);
    char[0] = 0x41 | (2 << 21); // 'A' with width metadata above bit 21
    char[1] = 0;
    const r = {
      currentRenderBuffer: {
        width,
        height: 1,
        buffers: { char, fg: new Uint16Array(width), bg: new Uint16Array(width), attributes: new Uint32Array(width) },
      },
    };
    expect(() => FrameProbe.Class.read(r)).not.toThrow();
    expect(FrameProbe.Class.read(r).rows[0]!.text).toBe('A');
  });
});
