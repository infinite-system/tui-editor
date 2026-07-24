// The image-decoder seam: ONE registry mapping a file extension to the decoder that turns raw bytes
// into straight-alpha RGBA. Every raster format shares the same generator — bytes in, {width, height,
// rgba} out — so format support lives HERE only: Workspace routing asks `supports`, ImagePreview asks
// `decoderFor`, and adding a format is one registry entry plus its decoder file. Neither consumer ever
// carries its own extension list. Pure and stateless — a Static capability like the decoders it holds.
//
// invariant: Seams are drawn at the shared generator (project.invariants.md)
// invariant: An image buffer replaces the code text and leaves other files untouched (src/modules/image/image.invariants.md)
import { Static } from 'ivue/extras';
import { PngDecoder } from './PngDecoder';
import { JpegDecoder } from './JpegDecoder';

/** A decoded raster image: dimensions plus a straight-alpha RGBA buffer of length width*height*4. */
export interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** A format decoder: raw file bytes to a DecodedImage; throws a clear Error on undecodable bytes. */
export type ImageDecoder = (bytes: Uint8Array) => DecodedImage;

class $ImageDecoders {
  static decoderFor = $decoderFor;
  static supports = $supports;
}

export namespace ImageDecoders {
  export const $Class = $ImageDecoders;
  export const Class = Static($ImageDecoders);
}

// The single source of truth for previewable raster formats: lowercase dot-extension → decoder.
const decodersByExtension: ReadonlyMap<string, ImageDecoder> = new Map([
  ['.png', PngDecoder.Class.decode],
  ['.jpg', JpegDecoder.Class.decode],
  ['.jpeg', JpegDecoder.Class.decode],
]);

/** The decoder registered for `extension` (case-insensitive, dot included), or null when the
 *  extension is not a supported raster format. */
function $decoderFor(extension: string): ImageDecoder | null {
  return decodersByExtension.get(extension.toLowerCase()) ?? null;
}

/** True when `extension` (case-insensitive, dot included) has a registered decoder. */
function $supports(extension: string): boolean {
  return decodersByExtension.has(extension.toLowerCase());
}
