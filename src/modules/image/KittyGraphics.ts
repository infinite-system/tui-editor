// The kitty graphics protocol encoder (APC `\x1b_G<controls>;<base64>\x1b\\`): transmits the decoded
// RGBA zlib-compressed (f=32, o=z) in ≤4096-byte base64 chunks and places it scaled into a cell rect
// (c=columns, r=rows — the terminal does the pixel scaling, so no resample is needed on this tier).
// Every placement carries an image id so it can be deleted EXPLICITLY (d=I frees the pixel data too);
// removeAll (d=A) is the app-quit guarantee that no image ever leaks onto the user's shell. q=2
// everywhere: the terminal must never answer, or its response bytes would land in the input parser.
// Pure and stateless — a Static capability; placement STATE (what is on screen) lives in the mount.
//
// invariant: A pixel tier places and deletes graphics explicitly (src/modules/image/image.invariants.md)
import { deflateSync } from 'node:zlib';
import { Static } from 'ivue/extras';
import type { DecodedImage } from './ImageDecoders';

/** One kitty placement request: the decoded image scaled into a columns×rows cell rect as `imageId`. */
export interface KittyPlacement {
  image: DecodedImage;
  /** The kitty image id (i=): stable per placement so delete targets exactly this image. */
  imageId: number;
  /** Cell columns the terminal scales the image into. */
  columns: number;
  /** Cell rows the terminal scales the image into. */
  rows: number;
}

class $KittyGraphics {
  static place = $place;
  static remove = $remove;
  static removeAll = $removeAll;
}

export namespace KittyGraphics {
  export const $Class = $KittyGraphics;
  export const Class = Static($KittyGraphics);
}

/** The kitty spec's hard ceiling for one APC chunk's base64 payload. */
export const KITTY_CHUNK_LIMIT = 4096;

function apc(controls: string, payload: string): string {
  return payload.length > 0 ? `\x1b_G${controls};${payload}\x1b\\` : `\x1b_G${controls}\x1b\\`;
}

/** Encode a transmit-and-display command: zlib-compressed raw RGBA, chunked at the 4096-byte base64
 *  limit (first chunk carries every control key + m=1, continuation chunks only m, final chunk m=0). */
function $place(placement: KittyPlacement): string {
  const { image, imageId, columns, rows } = placement;
  const compressed = deflateSync(image.rgba);
  const base64 = Buffer.from(compressed).toString('base64');
  // C=1: the cursor must not move — the mount brackets the emit with save/restore, but the terminal
  // not moving it in the first place keeps the two mechanisms from ever disagreeing.
  const controls =
    `a=T,f=32,o=z,s=${image.width},v=${image.height},` +
    `c=${columns},r=${rows},i=${imageId},C=1,q=2`;
  if (base64.length <= KITTY_CHUNK_LIMIT) return apc(controls, base64);
  const parts: string[] = [];
  for (let offset = 0; offset < base64.length; offset += KITTY_CHUNK_LIMIT) {
    const chunk = base64.slice(offset, offset + KITTY_CHUNK_LIMIT);
    const isFirst = offset === 0;
    const isLast = offset + KITTY_CHUNK_LIMIT >= base64.length;
    const chunkControls = isFirst ? `${controls},m=1` : `m=${isLast ? 0 : 1}`;
    parts.push(apc(chunkControls, chunk));
  }
  return parts.join('');
}

/** Delete the placement AND its transmitted pixel data (uppercase I) for `imageId`. */
function $remove(imageId: number): string {
  return apc(`a=d,d=I,i=${imageId},q=2`, '');
}

/** Delete every visible placement and its data — the app-dispose sweep. */
function $removeAll(): string {
  return apc('a=d,d=A,q=2', '');
}
