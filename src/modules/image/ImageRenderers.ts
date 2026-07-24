// The image-renderer ladder: ONE registry mapping a graphics tier to the encoder that turns decoded
// RGBA into that tier's escape payload. Every pixel tier shares the same generator — a decoded image
// plus a screen rect in, an emit-ready payload string out — so tier support lives HERE only: the
// mount asks `encoderFor(tier)` and a null answer IS the half-block cell fallback (the universal
// floor renders through the codeBody cells, not through an escape payload). Richer tiers stack above
// without touching the floor: kitty (terminal-scaled, explicit delete) over sixel (painted pixels,
// inert) over half-block. Pure and stateless — a Static capability like the encoders it holds.
//
// invariant: Seams are drawn at the shared generator (project.invariants.md)
// invariant: A pixel tier places and deletes graphics explicitly (src/modules/image/image.invariants.md)
import { Static } from 'ivue/extras';
import type { GraphicsTier } from '../theme/TerminalCapabilities';
import type { DecodedImage } from './ImageDecoders';
import { KittyGraphics } from './KittyGraphics';
import { SixelEncoder } from './SixelEncoder';

/** Everything a pixel-tier encoder may need to place one image into one screen rect. The mount fills
 *  every field; each encoder reads only what its protocol uses. */
export interface PixelPlacementContext {
  image: DecodedImage;
  /** Stable id for protocols with placement identity (kitty i=); ignored by paint-only protocols. */
  imageId: number;
  /** Aspect-fitted cell columns of the placement. */
  columns: number;
  /** Aspect-fitted cell rows of the placement. */
  rows: number;
  /** Aspect-fitted width in pixels (for protocols that need the pixels pre-scaled). */
  pixelWidth: number;
  /** Aspect-fitted height in pixels (for protocols that need the pixels pre-scaled). */
  pixelHeight: number;
  /** Background composited under transparency, as [red, green, blue] 0..255. */
  background: [number, number, number];
}

/** A pixel-tier encoder: placement/cleanup payloads ready for the terminal writer. Protocols without
 *  placement identity (sixel paints inert pixels) return '' from the delete encoders — emitting
 *  nothing IS their honest cleanup, because a later cell repaint overwrites the pixels. */
export interface PixelEncoder {
  place(context: PixelPlacementContext): string;
  remove(imageId: number): string;
  removeAll(): string;
}

class $ImageRenderers {
  static encoderFor = $encoderFor;
}

export namespace ImageRenderers {
  export const $Class = $ImageRenderers;
  export const Class = Static($ImageRenderers);
}

const kittyEncoder: PixelEncoder = {
  place: (context) =>
    KittyGraphics.Class.place({
      image: context.image,
      imageId: context.imageId,
      columns: context.columns,
      rows: context.rows,
    }),
  remove: (imageId) => KittyGraphics.Class.remove(imageId),
  removeAll: () => KittyGraphics.Class.removeAll(),
};

const sixelEncoder: PixelEncoder = {
  place: (context) =>
    SixelEncoder.Class.encode({
      image: context.image,
      pixelWidth: context.pixelWidth,
      pixelHeight: context.pixelHeight,
      background: context.background,
    }),
  remove: () => '',
  removeAll: () => '',
};

// The single source of truth for pixel tiers: tier → encoder. Half-block is DELIBERATELY absent —
// the null answer routes the preview through the cell renderer, the floor every terminal has.
const encodersByTier: ReadonlyMap<GraphicsTier, PixelEncoder> = new Map([
  ['kitty', kittyEncoder],
  ['sixel', sixelEncoder],
]);

/** The pixel encoder for `tier`, or null when the tier renders through cells (half-block floor). */
function $encoderFor(tier: GraphicsTier): PixelEncoder | null {
  return encodersByTier.get(tier) ?? null;
}
