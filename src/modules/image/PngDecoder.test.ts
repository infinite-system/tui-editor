// PngDecoder unit tests: synthetic PNGs encoded in-test (deterministic, no external files) exercise
// every supported colour type (grayscale/RGB/palette+tRNS/RGBA) and every scanline filter
// (None/Sub/Up/Average/Paeth) via a round-trip — the decoder must recover the exact original pixels —
// plus the unsupported-format guards (16-bit, interlaced) that must throw rather than crash. The real
// on-disk PNGs are the independent-encoder cross-check driven by scripts/smoke-image-preview.sh.
import { describe, test, expect } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { PngDecoder } from './PngDecoder';

// Standard Paeth predictor (PNG spec) used by the in-test ENCODER, independent of the decoder's copy.
function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceAbove = Math.abs(estimate - above);
  const distanceUpperLeft = Math.abs(estimate - upperLeft);
  if (distanceLeft <= distanceAbove && distanceLeft <= distanceUpperLeft) return left;
  if (distanceAbove <= distanceUpperLeft) return above;
  return upperLeft;
}

function be32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

// Build a valid PNG (CRC bytes left zero — the decoder does not verify them) from raw channel bytes,
// filtering each scanline with `filterType` so the round-trip proves the decoder's un-filter.
function encodePng(options: {
  width: number;
  height: number;
  colorType: number;
  channels: number;
  raw: Uint8Array;
  filterType: number;
  palette?: number[];
  transparency?: number[];
  bitDepth?: number;
  interlace?: number;
}): Uint8Array {
  const { width, height, colorType, channels, raw, filterType } = options;
  const bytesPerPixel = channels;
  const stride = width * bytesPerPixel;
  const filtered: number[] = [];
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    filtered.push(filterType);
    for (let byteIndex = 0; byteIndex < stride; byteIndex++) {
      const rawByte = raw[rowIndex * stride + byteIndex]!;
      const left = byteIndex >= bytesPerPixel ? raw[rowIndex * stride + byteIndex - bytesPerPixel]! : 0;
      const above = rowIndex > 0 ? raw[(rowIndex - 1) * stride + byteIndex]! : 0;
      const upperLeft =
        rowIndex > 0 && byteIndex >= bytesPerPixel ? raw[(rowIndex - 1) * stride + byteIndex - bytesPerPixel]! : 0;
      let predictor = 0;
      switch (filterType) {
        case 0: predictor = 0; break;
        case 1: predictor = left; break;
        case 2: predictor = above; break;
        case 3: predictor = (left + above) >> 1; break;
        case 4: predictor = paeth(left, above, upperLeft); break;
      }
      filtered.push((rawByte - predictor) & 0xff);
    }
  }
  const idat = deflateSync(Uint8Array.from(filtered));

  const bytes: number[] = [137, 80, 78, 71, 13, 10, 26, 10];
  const chunk = (type: string, data: number[]): void => {
    bytes.push(...be32(data.length));
    for (const character of type) bytes.push(character.charCodeAt(0));
    bytes.push(...data);
    bytes.push(0, 0, 0, 0); // CRC placeholder (unverified)
  };
  chunk('IHDR', [
    ...be32(width), ...be32(height),
    options.bitDepth ?? 8, colorType, 0, 0, options.interlace ?? 0,
  ]);
  if (options.palette) chunk('PLTE', options.palette);
  if (options.transparency) chunk('tRNS', options.transparency);
  chunk('IDAT', [...idat]);
  chunk('IEND', []);
  return Uint8Array.from(bytes);
}

describe('PngDecoder', () => {
  test('RGB (colour type 2) round-trips through every scanline filter', () => {
    const width = 4;
    const height = 3;
    const raw = new Uint8Array(width * height * 3);
    for (let index = 0; index < raw.length; index++) raw[index] = (index * 37 + 11) & 0xff; // varied gradient
    for (const filterType of [0, 1, 2, 3, 4]) {
      const png = encodePng({ width, height, colorType: 2, channels: 3, raw, filterType });
      const decoded = PngDecoder.Class.decode(png);
      expect(decoded.width).toBe(width);
      expect(decoded.height).toBe(height);
      expect(decoded.rgba.length).toBe(width * height * 4);
      for (let pixel = 0; pixel < width * height; pixel++) {
        expect(decoded.rgba[pixel * 4]).toBe(raw[pixel * 3]!);
        expect(decoded.rgba[pixel * 4 + 1]).toBe(raw[pixel * 3 + 1]!);
        expect(decoded.rgba[pixel * 4 + 2]).toBe(raw[pixel * 3 + 2]!);
        expect(decoded.rgba[pixel * 4 + 3]).toBe(255);
      }
    }
  });

  test('grayscale (colour type 0) expands each sample to opaque R=G=B', () => {
    const raw = Uint8Array.from([0, 64, 128, 255]);
    const decoded = PngDecoder.Class.decode(encodePng({ width: 4, height: 1, colorType: 0, channels: 1, raw, filterType: 4 }));
    expect([...decoded.rgba]).toEqual([0, 0, 0, 255, 64, 64, 64, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
  });

  test('palette (colour type 3) with tRNS resolves index → PLTE colour + per-index alpha', () => {
    const png = encodePng({
      width: 3, height: 1, colorType: 3, channels: 1,
      raw: Uint8Array.from([0, 1, 2]), filterType: 0,
      palette: [255, 0, 0, 0, 255, 0, 0, 0, 255],
      transparency: [10, 128], // index 2 has no tRNS entry → opaque
    });
    const decoded = PngDecoder.Class.decode(png);
    expect([...decoded.rgba]).toEqual([255, 0, 0, 10, 0, 255, 0, 128, 0, 0, 255, 255]);
  });

  test('RGBA (colour type 6) preserves straight alpha', () => {
    const raw = Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80]);
    const decoded = PngDecoder.Class.decode(encodePng({ width: 2, height: 1, colorType: 6, channels: 4, raw, filterType: 2 }));
    expect([...decoded.rgba]).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  });

  test('rejects a non-PNG buffer', () => {
    expect(() => PngDecoder.Class.decode(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/bad signature/);
  });

  test('rejects unsupported 16-bit depth with a clear error', () => {
    const png = encodePng({ width: 1, height: 1, colorType: 2, channels: 3, raw: Uint8Array.from([1, 2, 3]), filterType: 0, bitDepth: 16 });
    expect(() => PngDecoder.Class.decode(png)).toThrow(/bit depth/);
  });

  test('rejects interlaced images with a clear error', () => {
    const png = encodePng({ width: 1, height: 1, colorType: 2, channels: 3, raw: Uint8Array.from([1, 2, 3]), filterType: 0, interlace: 1 });
    expect(() => PngDecoder.Class.decode(png)).toThrow(/interlaced/);
  });
});
