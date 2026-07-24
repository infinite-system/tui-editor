// KittyGraphics unit tests: the APC framing is verified by ROUND-TRIP, not by brittle byte goldens —
// every chunk must respect the 4096-byte base64 ceiling and the m= continuation flags, and the
// concatenated payload must base64-decode + zlib-inflate back to the EXACT transmitted RGBA. The
// delete commands are small enough to pin exactly.
// invariant: A pixel tier places and deletes graphics explicitly (src/modules/image/image.invariants.md)
import { describe, test, expect } from 'bun:test';
import { inflateSync } from 'node:zlib';
import { KittyGraphics, KITTY_CHUNK_LIMIT } from './KittyGraphics';
import type { DecodedImage } from './ImageDecoders';

/** Split a payload of concatenated APC sequences into { controls, payload } parts. */
function parseApcSequences(payload: string): Array<{ controls: string; payload: string }> {
  const sequences: Array<{ controls: string; payload: string }> = [];
  const pattern = /\x1b_G([^;\x1b]*)(?:;([^\x1b]*))?\x1b\\/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(payload)) !== null) {
    sequences.push({ controls: match[1] ?? '', payload: match[2] ?? '' });
  }
  return sequences;
}

function solidImage(width: number, height: number, channelSeed: number): DecodedImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < rgba.length; offset++) rgba[offset] = (channelSeed + offset * 7) & 0xff;
  return { width, height, rgba };
}

describe('KittyGraphics', () => {
  test('a small image emits ONE transmit-and-display APC whose payload round-trips to the RGBA', () => {
    const image = solidImage(4, 3, 10);
    const emitted = KittyGraphics.Class.place({ image, imageId: 7001, columns: 8, rows: 2 });
    const sequences = parseApcSequences(emitted);
    expect(sequences.length).toBe(1);
    const controls = sequences[0]!.controls;
    for (const expected of ['a=T', 'f=32', 'o=z', 's=4', 'v=3', 'c=8', 'r=2', 'i=7001', 'C=1', 'q=2']) {
      expect(controls.split(',')).toContain(expected);
    }
    const roundTripped = new Uint8Array(inflateSync(Buffer.from(sequences[0]!.payload, 'base64')));
    expect(Buffer.compare(roundTripped, image.rgba)).toBe(0);
  });

  test('a large image chunks at the 4096-byte base64 ceiling with honest m= flags and round-trips', () => {
    // Random-ish bytes defeat zlib so the base64 stays large enough to force several chunks.
    const image = solidImage(128, 128, 3);
    let seed = 99;
    for (let offset = 0; offset < image.rgba.length; offset++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; // 32-bit LCG (imul keeps the low bits honest)
      image.rgba[offset] = (seed >>> 16) & 0xff;
    }
    const emitted = KittyGraphics.Class.place({ image, imageId: 7002, columns: 40, rows: 20 });
    const sequences = parseApcSequences(emitted);
    expect(sequences.length).toBeGreaterThan(2);
    for (const sequence of sequences) expect(sequence.payload.length).toBeLessThanOrEqual(KITTY_CHUNK_LIMIT);
    // First chunk: full controls + m=1. Middle chunks: exactly m=1. Final chunk: exactly m=0.
    expect(sequences[0]!.controls).toContain('a=T');
    expect(sequences[0]!.controls).toContain('m=1');
    for (const middle of sequences.slice(1, -1)) expect(middle.controls).toBe('m=1');
    expect(sequences[sequences.length - 1]!.controls).toBe('m=0');
    const joined = sequences.map((sequence) => sequence.payload).join('');
    const roundTripped = new Uint8Array(inflateSync(Buffer.from(joined, 'base64')));
    expect(Buffer.compare(roundTripped, image.rgba)).toBe(0);
  });

  test('remove targets exactly one image id and also frees its data (d=I)', () => {
    expect(KittyGraphics.Class.remove(7001)).toBe('\x1b_Ga=d,d=I,i=7001,q=2\x1b\\');
  });

  test('removeAll is the dispose sweep (d=A)', () => {
    expect(KittyGraphics.Class.removeAll()).toBe('\x1b_Ga=d,d=A,q=2\x1b\\');
  });
});
