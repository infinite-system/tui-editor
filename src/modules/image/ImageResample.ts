// The shared resample generator every image projection consumes: fit a decoded image into a target
// box preserving aspect, box-average the source pixels per target sample (straight-alpha), and
// composite over a background colour — an RGB grid out. HalfBlockRenderer feeds it a columns×(2·rows)
// subpixel box; the sixel encoder feeds it a pixel box; the kitty tier uses only the fit (the
// terminal scales the pixels itself). The units differ, the generator does not — which is exactly why
// this lives in ONE place instead of once per projection.
//
// invariant: Seams are drawn at the shared generator (project.invariants.md)
// invariant: A raster image renders as half-block cells sized to the pane (src/modules/image/image.invariants.md)
import { Static } from 'ivue/extras';
import type { DecodedImage } from './ImageDecoders';

/** A fitted size: the largest aspect-preserving fit of a source into a box, each dimension ≥ 1. */
export interface FittedSize {
  width: number;
  height: number;
}

class $ImageResample {
  static fitWithin = $fitWithin;
  static toRgbGrid = $toRgbGrid;
}

export namespace ImageResample {
  export const $Class = $ImageResample;
  export const Class = Static($ImageResample);
}

/** Fit `sourceWidth × sourceHeight` into `boxWidth × boxHeight` preserving aspect: the tighter of the
 *  two scale ratios wins; each fitted dimension is clamped to [1, box]. */
function $fitWithin(sourceWidth: number, sourceHeight: number, boxWidth: number, boxHeight: number): FittedSize {
  const scale = Math.min(boxWidth / sourceWidth, boxHeight / sourceHeight);
  return {
    width: Math.max(1, Math.min(boxWidth, Math.round(sourceWidth * scale))),
    height: Math.max(1, Math.min(boxHeight, Math.round(sourceHeight * scale))),
  };
}

/** Box-downsample `image` to a `targetWidth × targetHeight` grid, averaging every source pixel that
 *  falls in each target sample's box (weighted by alpha), then compositing the averaged coverage over
 *  the background so transparency reads as the background colour. Returns a flat RGB grid (3 bytes per
 *  sample, row-major). */
function $toRgbGrid(
  image: DecodedImage,
  targetWidth: number,
  targetHeight: number,
  backgroundRed: number,
  backgroundGreen: number,
  backgroundBlue: number,
): Uint8Array {
  const grid = new Uint8Array(targetWidth * targetHeight * 3);
  const { width, height, rgba } = image;
  for (let targetY = 0; targetY < targetHeight; targetY++) {
    const sourceRowStart = Math.floor((targetY * height) / targetHeight);
    const sourceRowEnd = Math.max(sourceRowStart + 1, Math.floor(((targetY + 1) * height) / targetHeight));
    for (let targetX = 0; targetX < targetWidth; targetX++) {
      const sourceColumnStart = Math.floor((targetX * width) / targetWidth);
      const sourceColumnEnd = Math.max(sourceColumnStart + 1, Math.floor(((targetX + 1) * width) / targetWidth));
      let redTotal = 0;
      let greenTotal = 0;
      let blueTotal = 0;
      let alphaTotal = 0;
      let sampleCount = 0;
      for (let sourceY = sourceRowStart; sourceY < sourceRowEnd; sourceY++) {
        for (let sourceX = sourceColumnStart; sourceX < sourceColumnEnd; sourceX++) {
          const sourceOffset = (sourceY * width + sourceX) * 4;
          const alpha = rgba[sourceOffset + 3]! / 255;
          redTotal += rgba[sourceOffset]! * alpha;
          greenTotal += rgba[sourceOffset + 1]! * alpha;
          blueTotal += rgba[sourceOffset + 2]! * alpha;
          alphaTotal += alpha;
          sampleCount++;
        }
      }
      // Average colour weighted by alpha, then composite the averaged coverage over the background.
      const coverage = sampleCount > 0 ? alphaTotal / sampleCount : 0;
      const averageRed = alphaTotal > 0 ? redTotal / alphaTotal : 0;
      const averageGreen = alphaTotal > 0 ? greenTotal / alphaTotal : 0;
      const averageBlue = alphaTotal > 0 ? blueTotal / alphaTotal : 0;
      const gridOffset = (targetY * targetWidth + targetX) * 3;
      grid[gridOffset] = averageRed * coverage + backgroundRed * (1 - coverage);
      grid[gridOffset + 1] = averageGreen * coverage + backgroundGreen * (1 - coverage);
      grid[gridOffset + 2] = averageBlue * coverage + backgroundBlue * (1 - coverage);
    }
  }
  return grid;
}
