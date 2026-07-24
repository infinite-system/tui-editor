// The sixel encoder: resamples the decoded image to the target PIXEL rect through the shared resample
// seam, quantizes to a fixed 6×6×6 colour cube (216 palette entries — a stable palette beats a
// per-image median cut for a preview: deterministic output, no perceptible banding at preview sizes),
// and emits one DCS sequence: raster attributes, palette definitions for the colours actually used,
// then per-6-row bands of run-length-encoded sixel characters (one pass per colour present in the
// band, `$` carriage returns between colours, `-` between bands). Sixel pixels are inert once painted
// — there is nothing to delete; a later cell repaint over the region simply overwrites them.
// Pure and stateless — a Static capability.
//
// invariant: A pixel tier places and deletes graphics explicitly (src/modules/image/image.invariants.md)
import { Static } from 'ivue/extras';
import type { DecodedImage } from './ImageDecoders';
import { ImageResample } from './ImageResample';

/** One sixel paint request: the decoded image resampled to an exact pixel rect over a background. */
export interface SixelPaint {
  image: DecodedImage;
  /** Target width in PIXELS (already aspect-fitted by the caller). */
  pixelWidth: number;
  /** Target height in PIXELS (already aspect-fitted by the caller). */
  pixelHeight: number;
  /** Background composited under transparency, as [red, green, blue] 0..255. */
  background: [number, number, number];
}

class $SixelEncoder {
  static encode = $encode;
}

export namespace SixelEncoder {
  export const $Class = $SixelEncoder;
  export const Class = Static($SixelEncoder);
}

// The fixed 6-level channel ladder: 0, 51, 102, 153, 204, 255 → sixel's 0..100 scale.
const CHANNEL_LEVELS = 6;

/** Quantize an 0..255 channel to its 6-level index. */
function channelIndex(value: number): number {
  return Math.round((value / 255) * (CHANNEL_LEVELS - 1));
}

/** The sixel palette register (0..215) for an RGB sample. */
function paletteIndex(red: number, green: number, blue: number): number {
  return channelIndex(red) * CHANNEL_LEVELS * CHANNEL_LEVELS + channelIndex(green) * CHANNEL_LEVELS + channelIndex(blue);
}

/** A palette register's channel value on sixel's 0..100 scale. */
function paletteChannel(levelIndex: number): number {
  return Math.round((levelIndex / (CHANNEL_LEVELS - 1)) * 100);
}

function $encode(paint: SixelPaint): string {
  const { image, pixelWidth, pixelHeight, background } = paint;
  const grid = ImageResample.Class.toRgbGrid(
    image, pixelWidth, pixelHeight, background[0], background[1], background[2],
  );

  // Quantize every sample to its palette register once; collect the used registers.
  const registers = new Uint8Array(pixelWidth * pixelHeight);
  const usedRegisters = new Set<number>();
  for (let sampleIndex = 0; sampleIndex < pixelWidth * pixelHeight; sampleIndex++) {
    const gridOffset = sampleIndex * 3;
    const register = paletteIndex(grid[gridOffset]!, grid[gridOffset + 1]!, grid[gridOffset + 2]!);
    registers[sampleIndex] = register;
    usedRegisters.add(register);
  }

  // DCS introducer (P2=1: unset pixels keep the screen content) + raster attributes (1:1 aspect).
  const parts: string[] = [`\x1bP0;1;0q"1;1;${pixelWidth};${pixelHeight}`];
  for (const register of [...usedRegisters].sort((left, right) => left - right)) {
    const redLevel = Math.floor(register / (CHANNEL_LEVELS * CHANNEL_LEVELS));
    const greenLevel = Math.floor(register / CHANNEL_LEVELS) % CHANNEL_LEVELS;
    const blueLevel = register % CHANNEL_LEVELS;
    parts.push(`#${register};2;${paletteChannel(redLevel)};${paletteChannel(greenLevel)};${paletteChannel(blueLevel)}`);
  }

  // Emit 6-row bands: per colour present in the band, one RLE pass over the columns.
  const bandCount = Math.ceil(pixelHeight / 6);
  for (let bandIndex = 0; bandIndex < bandCount; bandIndex++) {
    const bandTop = bandIndex * 6;
    // Which registers appear in this band, and each column's 6-bit mask per register.
    const bandRegisters = new Set<number>();
    for (let rowOffset = 0; rowOffset < 6; rowOffset++) {
      const y = bandTop + rowOffset;
      if (y >= pixelHeight) break;
      for (let x = 0; x < pixelWidth; x++) bandRegisters.add(registers[y * pixelWidth + x]!);
    }
    const passes: string[] = [];
    for (const register of [...bandRegisters].sort((left, right) => left - right)) {
      let pass = `#${register}`;
      let runCharacter = '';
      let runLength = 0;
      const flushRun = (): void => {
        if (runLength === 0) return;
        // RLE pays for itself from 4 repeats (`!<n>c` is 4+ chars); shorter runs emit literally.
        pass += runLength >= 4 ? `!${runLength}${runCharacter}` : runCharacter.repeat(runLength);
        runLength = 0;
      };
      for (let x = 0; x < pixelWidth; x++) {
        let mask = 0;
        for (let rowOffset = 0; rowOffset < 6; rowOffset++) {
          const y = bandTop + rowOffset;
          if (y >= pixelHeight) break;
          if (registers[y * pixelWidth + x] === register) mask |= 1 << rowOffset;
        }
        const character = String.fromCharCode(63 + mask);
        if (character === runCharacter) runLength++;
        else {
          flushRun();
          runCharacter = character;
          runLength = 1;
        }
      }
      flushRun();
      passes.push(pass);
    }
    parts.push(passes.join('$'));
    parts.push(bandIndex < bandCount - 1 ? '-' : '');
  }
  parts.push('\x1b\\');
  return parts.join('');
}
