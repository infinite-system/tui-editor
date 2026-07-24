// ImageRenderers ladder tests: the registry is the ONE source of truth for pixel tiers — kitty and
// sixel answer with encoders, the half-block floor answers null (cells, not escapes), and each
// encoder's cleanup contract is honest: kitty deletes by id, sixel's cleanup is the empty string
// because painted pixels are inert.
// invariant: Seams are drawn at the shared generator (project.invariants.md)
import { describe, test, expect } from 'bun:test';
import { ImageRenderers, type PixelPlacementContext } from './ImageRenderers';
import type { DecodedImage } from './ImageDecoders';

function redImage(width: number, height: number): DecodedImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([255, 0, 0, 255], offset);
  return { width, height, rgba };
}

function placementContext(): PixelPlacementContext {
  return {
    image: redImage(4, 6),
    imageId: 7010,
    columns: 4,
    rows: 3,
    pixelWidth: 4,
    pixelHeight: 6,
    background: [0, 0, 0],
  };
}

describe('ImageRenderers', () => {
  test('the half-block floor is the null answer — cells, never an escape payload', () => {
    expect(ImageRenderers.Class.encoderFor('halfblock')).toBeNull();
  });

  test('the kitty tier places an APC with the placement id and deletes by that id', () => {
    const encoder = ImageRenderers.Class.encoderFor('kitty');
    expect(encoder).not.toBeNull();
    const placed = encoder!.place(placementContext());
    expect(placed.startsWith('\x1b_G')).toBe(true);
    expect(placed).toContain('i=7010');
    expect(placed).toContain('c=4');
    expect(placed).toContain('r=3');
    expect(encoder!.remove(7010)).toContain('i=7010');
    expect(encoder!.removeAll()).toContain('d=A');
  });

  test('the sixel tier paints a DCS at the pixel rect and has empty (inert-pixel) cleanup', () => {
    const encoder = ImageRenderers.Class.encoderFor('sixel');
    expect(encoder).not.toBeNull();
    const painted = encoder!.place(placementContext());
    expect(painted.startsWith('\x1bP')).toBe(true);
    expect(painted).toContain('"1;1;4;6');
    expect(painted.endsWith('\x1b\\')).toBe(true);
    expect(encoder!.remove(7010)).toBe('');
    expect(encoder!.removeAll()).toBe('');
  });
});
