// A dependency-free PNG decoder: signature + chunk parse (IHDR/PLTE/tRNS/IDAT/IEND), zlib inflate of
// the concatenated IDAT stream (node:zlib, which Bun implements), scanline un-filtering (all five
// filter types including Paeth), and channel expansion to straight-alpha RGBA. Supports bit depth 8
// and colour types 0 (grayscale), 2 (RGB), 3 (palette + optional tRNS), 6 (RGBA); non-interlaced.
// Anything else (interlaced, 16-bit) throws a clear Error so the caller shows a friendly message and
// never crashes. Pure and stateless — a Static capability so the renderer can decode any byte buffer.
//
// invariant: A raster image renders as half-block cells sized to the pane (src/modules/image/image.invariants.md)
import { inflateSync } from 'node:zlib';
import { Static } from 'ivue/extras';

/** A decoded raster image: dimensions plus a straight-alpha RGBA buffer of length width*height*4. */
export interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

class $PngDecoder {
  static decode = $decode;
}

export namespace PngDecoder {
  export const $Class = $PngDecoder;
  export const Class = Static($PngDecoder);
}

// The eight fixed bytes every PNG file opens with (\x89 P N G \r \n \x1a \n).
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Channel count for each supported colour type at bit depth 8 (grayscale 1, RGB 3, palette 1, RGBA 4). */
function channelsForColorType(colorType: number): number {
  switch (colorType) {
    case 0: return 1; // grayscale
    case 2: return 3; // truecolor RGB
    case 3: return 1; // palette index
    case 6: return 4; // truecolor with alpha
    default: throw new Error(`PNG: unsupported colour type ${colorType}`);
  }
}

// The Paeth predictor (PNG spec 9.4): choose whichever of the left, above, or upper-left reconstructed
// bytes is closest to the linear estimate left + above - upperLeft, resolving ties toward left.
function paethPredictor(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const distanceToLeft = Math.abs(estimate - left);
  const distanceToAbove = Math.abs(estimate - above);
  const distanceToUpperLeft = Math.abs(estimate - upperLeft);
  if (distanceToLeft <= distanceToAbove && distanceToLeft <= distanceToUpperLeft) return left;
  if (distanceToAbove <= distanceToUpperLeft) return above;
  return upperLeft;
}

// Reconstruct the raw (unfiltered) scanline bytes in place: each of the height scanlines is prefixed by
// one filter-type byte, and each filtered byte is reconstructed from its left (bytesPerPixel back) and
// above (previous scanline) neighbours per the filter type. Returns the height*stride byte grid.
function unfilterScanlines(
  inflated: Uint8Array,
  width: number,
  height: number,
  bytesPerPixel: number,
): Uint8Array {
  const stride = width * bytesPerPixel;
  const raw = new Uint8Array(height * stride);
  let inflatedOffset = 0;
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    const filterType = inflated[inflatedOffset++]!;
    const rawRowStart = rowIndex * stride;
    for (let byteIndex = 0; byteIndex < stride; byteIndex++) {
      const filteredByte = inflated[inflatedOffset++]!;
      const leftByte = byteIndex >= bytesPerPixel ? raw[rawRowStart + byteIndex - bytesPerPixel]! : 0;
      const aboveByte = rowIndex > 0 ? raw[rawRowStart - stride + byteIndex]! : 0;
      const upperLeftByte =
        rowIndex > 0 && byteIndex >= bytesPerPixel ? raw[rawRowStart - stride + byteIndex - bytesPerPixel]! : 0;
      let reconstructedByte: number;
      switch (filterType) {
        case 0: reconstructedByte = filteredByte; break; // None
        case 1: reconstructedByte = filteredByte + leftByte; break; // Sub
        case 2: reconstructedByte = filteredByte + aboveByte; break; // Up
        case 3: reconstructedByte = filteredByte + ((leftByte + aboveByte) >> 1); break; // Average
        case 4: reconstructedByte = filteredByte + paethPredictor(leftByte, aboveByte, upperLeftByte); break; // Paeth
        default: throw new Error(`PNG: unsupported scanline filter ${filterType}`);
      }
      raw[rawRowStart + byteIndex] = reconstructedByte & 0xff;
    }
  }
  return raw;
}

// Expand the reconstructed channel grid into straight-alpha RGBA, per colour type.
function expandToRgba(
  raw: Uint8Array,
  width: number,
  height: number,
  colorType: number,
  channels: number,
  palette: Uint8Array | null,
  paletteAlpha: Uint8Array | null,
): Uint8Array {
  const pixelCount = width * height;
  const rgba = new Uint8Array(pixelCount * 4);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const sourceOffset = pixelIndex * channels;
    const targetOffset = pixelIndex * 4;
    if (colorType === 0) {
      const gray = raw[sourceOffset]!;
      rgba[targetOffset] = gray;
      rgba[targetOffset + 1] = gray;
      rgba[targetOffset + 2] = gray;
      rgba[targetOffset + 3] = 255;
    } else if (colorType === 2) {
      rgba[targetOffset] = raw[sourceOffset]!;
      rgba[targetOffset + 1] = raw[sourceOffset + 1]!;
      rgba[targetOffset + 2] = raw[sourceOffset + 2]!;
      rgba[targetOffset + 3] = 255;
    } else if (colorType === 3) {
      const paletteIndex = raw[sourceOffset]!;
      if (!palette) throw new Error('PNG: palette colour type without a PLTE chunk');
      rgba[targetOffset] = palette[paletteIndex * 3]!;
      rgba[targetOffset + 1] = palette[paletteIndex * 3 + 1]!;
      rgba[targetOffset + 2] = palette[paletteIndex * 3 + 2]!;
      rgba[targetOffset + 3] = paletteAlpha && paletteIndex < paletteAlpha.length ? paletteAlpha[paletteIndex]! : 255;
    } else {
      rgba[targetOffset] = raw[sourceOffset]!;
      rgba[targetOffset + 1] = raw[sourceOffset + 1]!;
      rgba[targetOffset + 2] = raw[sourceOffset + 2]!;
      rgba[targetOffset + 3] = raw[sourceOffset + 3]!;
    }
  }
  return rgba;
}

function $decode(bytes: Uint8Array): DecodedImage {
  for (let index = 0; index < PNG_SIGNATURE.length; index++) {
    if (bytes[index] !== PNG_SIGNATURE[index]) throw new Error('PNG: not a PNG file (bad signature)');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlaceMethod = 0;
  let palette: Uint8Array | null = null;
  let paletteAlpha: Uint8Array | null = null;
  const idatSegments: Uint8Array[] = [];

  let chunkOffset = PNG_SIGNATURE.length;
  let sawHeader = false;
  while (chunkOffset + 8 <= bytes.length) {
    const chunkLength = view.getUint32(chunkOffset);
    const chunkType = String.fromCharCode(
      bytes[chunkOffset + 4]!, bytes[chunkOffset + 5]!, bytes[chunkOffset + 6]!, bytes[chunkOffset + 7]!,
    );
    const dataOffset = chunkOffset + 8;
    if (chunkType === 'IHDR') {
      width = view.getUint32(dataOffset);
      height = view.getUint32(dataOffset + 4);
      bitDepth = bytes[dataOffset + 8]!;
      colorType = bytes[dataOffset + 9]!;
      interlaceMethod = bytes[dataOffset + 12]!;
      sawHeader = true;
    } else if (chunkType === 'PLTE') {
      palette = bytes.slice(dataOffset, dataOffset + chunkLength);
    } else if (chunkType === 'tRNS') {
      paletteAlpha = bytes.slice(dataOffset, dataOffset + chunkLength);
    } else if (chunkType === 'IDAT') {
      idatSegments.push(bytes.slice(dataOffset, dataOffset + chunkLength));
    } else if (chunkType === 'IEND') {
      break;
    }
    chunkOffset = dataOffset + chunkLength + 4; // skip chunk data + 4-byte CRC
  }

  if (!sawHeader) throw new Error('PNG: missing IHDR chunk');
  if (bitDepth !== 8) throw new Error(`PNG: unsupported bit depth ${bitDepth} (only 8-bit supported)`);
  if (interlaceMethod !== 0) throw new Error('PNG: interlaced images are not supported');
  if (idatSegments.length === 0) throw new Error('PNG: no image data (IDAT) found');

  const channels = channelsForColorType(colorType);
  const compressedLength = idatSegments.reduce((total, segment) => total + segment.length, 0);
  const compressed = new Uint8Array(compressedLength);
  let compressedOffset = 0;
  for (const segment of idatSegments) {
    compressed.set(segment, compressedOffset);
    compressedOffset += segment.length;
  }
  const inflated = new Uint8Array(inflateSync(compressed));
  const bytesPerPixel = channels; // bit depth 8: one byte per channel
  const raw = unfilterScanlines(inflated, width, height, bytesPerPixel);
  const rgba = expandToRgba(raw, width, height, colorType, channels, palette, paletteAlpha);
  return { width, height, rgba };
}
