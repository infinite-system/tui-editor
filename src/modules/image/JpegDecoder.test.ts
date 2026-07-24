// JpegDecoder unit tests: synthetic JPEGs encoded in-test via jpeg-js's own encoder (deterministic,
// no external files) prove the decode wrapper produces the seam's contract shape — straight-alpha
// RGBA of length width*height*4 — and that flat-colour regions survive the lossy round-trip within a
// small tolerance (JPEG is lossy; exact-pixel equality is the wrong assertion). Undecodable bytes
// must throw a clear Error, never crash. The real on-disk photo is the independent cross-check driven
// by scripts/smoke-image-preview.sh.
import { describe, test, expect } from 'bun:test';
import { encode as encodeJpeg } from 'jpeg-js';
import { JpegDecoder } from './JpegDecoder';

/** Encode a solid-colour-bands RGBA frame as a JPEG at high quality (small loss, big tolerance). */
function encodeBandsJpeg(width: number, height: number, bands: [number, number, number][]): Uint8Array {
  const frame = new Uint8Array(width * height * 4);
  const bandHeight = height / bands.length;
  for (let y = 0; y < height; y++) {
    const band = bands[Math.min(bands.length - 1, Math.floor(y / bandHeight))]!;
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      frame[offset] = band[0];
      frame[offset + 1] = band[1];
      frame[offset + 2] = band[2];
      frame[offset + 3] = 255;
    }
  }
  return new Uint8Array(encodeJpeg({ data: frame, width, height }, 95).data);
}

/** Average [red, green, blue] over a pixel rectangle of the decoded RGBA buffer. */
function averageColor(
  rgba: Uint8Array,
  width: number,
  startX: number,
  startY: number,
  spanX: number,
  spanY: number,
): [number, number, number] {
  let red = 0;
  let green = 0;
  let blue = 0;
  const pixelCount = spanX * spanY;
  for (let y = startY; y < startY + spanY; y++) {
    for (let x = startX; x < startX + spanX; x++) {
      const offset = (y * width + x) * 4;
      red += rgba[offset]!;
      green += rgba[offset + 1]!;
      blue += rgba[offset + 2]!;
    }
  }
  return [red / pixelCount, green / pixelCount, blue / pixelCount];
}

describe('JpegDecoder', () => {
  test('decodes a synthetic JPEG to the contract shape: dims plus rgba of length width*height*4', () => {
    const width = 32;
    const height = 32;
    const bytes = encodeBandsJpeg(width, height, [[255, 0, 0]]);
    const image = JpegDecoder.Class.decode(bytes);
    expect(image.width).toBe(width);
    expect(image.height).toBe(height);
    expect(image.rgba.length).toBe(width * height * 4);
  });

  test('colour bands survive the lossy round-trip within tolerance, alpha is opaque', () => {
    const width = 64;
    const height = 64;
    const bytes = encodeBandsJpeg(width, height, [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ]);
    const image = JpegDecoder.Class.decode(bytes);
    // Sample the CENTER of each band (block artifacts live at band edges, not centers).
    const topBand = averageColor(image.rgba, width, 16, 5, 32, 8);
    const middleBand = averageColor(image.rgba, width, 16, 27, 32, 8);
    const bottomBand = averageColor(image.rgba, width, 16, 48, 32, 8);
    const tolerance = 24;
    expect(topBand[0]).toBeGreaterThan(255 - tolerance);
    expect(topBand[1]).toBeLessThan(tolerance);
    expect(topBand[2]).toBeLessThan(tolerance);
    expect(middleBand[1]).toBeGreaterThan(255 - tolerance);
    expect(middleBand[0]).toBeLessThan(tolerance);
    expect(bottomBand[2]).toBeGreaterThan(255 - tolerance);
    expect(bottomBand[0]).toBeLessThan(tolerance);
    // Every fourth byte is alpha and must be fully opaque (formatAsRGBA straight-alpha contract).
    for (let alphaOffset = 3; alphaOffset < image.rgba.length; alphaOffset += 400) {
      expect(image.rgba[alphaOffset]).toBe(255);
    }
  });

  test('undecodable bytes throw a clear Error instead of crashing', () => {
    const notAJpeg = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
    expect(() => JpegDecoder.Class.decode(notAJpeg)).toThrow();
  });
});
