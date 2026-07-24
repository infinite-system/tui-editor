// JPEG decoding via the pure-JS `jpeg-js` package (baseline + progressive, chroma subsampling,
// EXIF-carrying files — hand-rolling Huffman+DCT is out of scope by decision). The wrapper pins the
// options that make jpeg-js honest for the preview path: `useTArray` for a Uint8Array out,
// `formatAsRGBA` for the straight-alpha RGBA layout HalfBlockRenderer consumes, and a generous
// memory ceiling so a phone photo decodes instead of throwing. Undecodable bytes throw jpeg-js's own
// clear Error so the caller shows a friendly message and never crashes. Pure and stateless — a Static
// capability, the '.jpg'/'.jpeg' instance of the ImageDecoders seam.
//
// invariant: A raster image renders as half-block cells sized to the pane (src/modules/image/image.invariants.md)
import { decode as decodeJpeg } from 'jpeg-js';
import { Static } from 'ivue/extras';
import type { DecodedImage } from './ImageDecoders';

class $JpegDecoder {
  static decode = $decode;
}

export namespace JpegDecoder {
  export const $Class = $JpegDecoder;
  export let Class = Static($JpegDecoder);
}

// Decode memory ceiling: a 48-megapixel photo needs ~192MB of RGBA plus working buffers; anything
// larger is not a previewable photo and gets jpeg-js's clear "allocate too much memory" Error.
const MAX_DECODE_MEMORY_MB = 1024;

function $decode(bytes: Uint8Array): DecodedImage {
  const decoded = decodeJpeg(bytes, {
    useTArray: true,
    formatAsRGBA: true,
    maxMemoryUsageInMB: MAX_DECODE_MEMORY_MB,
  });
  return { width: decoded.width, height: decoded.height, rgba: decoded.data };
}
