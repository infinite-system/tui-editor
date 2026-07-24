// SixelEncoder unit tests: tiny fixtures small enough that the EXACT sixel byte stream is computable
// by hand — golden outputs pin the DCS framing, raster attributes, palette definitions (0..100
// scale), per-band colour passes with `$` carriage returns, RLE from 4 repeats, and the final ST.
// Alpha compositing is proven by a transparent image landing on the background's palette register.
// invariant: A pixel tier places and deletes graphics explicitly (src/modules/image/image.invariants.md)
import { describe, test, expect } from 'bun:test';
import { SixelEncoder } from './SixelEncoder';
import type { DecodedImage } from './ImageDecoders';

function imageFromPixels(width: number, height: number, pixels: [number, number, number, number][]): DecodedImage {
  const rgba = new Uint8Array(width * height * 4);
  pixels.forEach((pixel, pixelIndex) => rgba.set(pixel, pixelIndex * 4));
  return { width, height, rgba };
}

function solidImage(width: number, height: number, pixel: [number, number, number, number]): DecodedImage {
  return imageFromPixels(width, height, Array.from({ length: width * height }, () => pixel));
}

describe('SixelEncoder', () => {
  test('golden: a solid red 4x6 image is one palette def and one RLE run', () => {
    // Red 255,0,0 → levels (5,0,0) → register 180 → palette #180;2;100;0;0.
    // All 6 rows set → mask 63 → '~'; 4 identical columns → RLE '!4~'.
    const emitted = SixelEncoder.Class.encode({
      image: solidImage(4, 6, [255, 0, 0, 255]),
      pixelWidth: 4,
      pixelHeight: 6,
      background: [0, 0, 0],
    });
    expect(emitted).toBe('\x1bP0;1;0q"1;1;4;6#180;2;100;0;0#180!4~\x1b\\');
  });

  test('golden: left-red right-blue splits into two colour passes joined by a carriage return', () => {
    // Blue 0,0,255 → register 5; red → 180. Registers emit sorted; runs of 2 stay literal.
    const pixels: [number, number, number, number][] = [];
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 4; x++) pixels.push(x < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255]);
    }
    const emitted = SixelEncoder.Class.encode({
      image: imageFromPixels(4, 6, pixels),
      pixelWidth: 4,
      pixelHeight: 6,
      background: [0, 0, 0],
    });
    expect(emitted).toBe('\x1bP0;1;0q"1;1;4;6#5;2;0;0;100#180;2;100;0;0#5??~~$#180~~??\x1b\\');
  });

  test('golden: a height that is not a multiple of six clips the last band mask', () => {
    // 3 rows set → mask 0b111 = 7 → character '?'+7 = 'F'. White → register 215 → 100;100;100.
    const emitted = SixelEncoder.Class.encode({
      image: solidImage(2, 3, [255, 255, 255, 255]),
      pixelWidth: 2,
      pixelHeight: 3,
      background: [0, 0, 0],
    });
    expect(emitted).toBe('\x1bP0;1;0q"1;1;2;3#215;2;100;100;100#215FF\x1b\\');
  });

  test('multiple bands are separated by the band terminator', () => {
    const emitted = SixelEncoder.Class.encode({
      image: solidImage(2, 12, [0, 255, 0, 255]),
      pixelWidth: 2,
      pixelHeight: 12,
      background: [0, 0, 0],
    });
    // Green → register 30. Two full bands of mask 63, separated by '-'.
    expect(emitted).toBe('\x1bP0;1;0q"1;1;2;12#30;2;0;100;0#30~~-#30~~\x1b\\');
  });

  test('transparency composites over the background before quantization', () => {
    // A fully transparent image over a mid-gray background must emit the BACKGROUND's register,
    // never black: 153,153,153 → levels (3,3,3) → register 129.
    const emitted = SixelEncoder.Class.encode({
      image: solidImage(2, 6, [255, 0, 0, 0]),
      pixelWidth: 2,
      pixelHeight: 6,
      background: [153, 153, 153],
    });
    expect(emitted).toBe('\x1bP0;1;0q"1;1;2;6#129;2;60;60;60#129~~\x1b\\');
  });

  test('the encoder resamples: a large source lands on the requested pixel rect', () => {
    // 100x100 red source into an 8x6 rect — the output frames 8x6 and stays a single red run.
    const emitted = SixelEncoder.Class.encode({
      image: solidImage(100, 100, [255, 0, 0, 255]),
      pixelWidth: 8,
      pixelHeight: 6,
      background: [0, 0, 0],
    });
    expect(emitted).toBe('\x1bP0;1;0q"1;1;8;6#180;2;100;0;0#180!8~\x1b\\');
  });
});
