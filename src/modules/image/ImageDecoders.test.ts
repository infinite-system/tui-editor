// ImageDecoders registry tests: the seam is the ONE source of truth for previewable raster formats —
// `supports` answers routing (Workspace.activeFileIsImage), `decoderFor` hands ImagePreview the
// format's decoder, and both are case-insensitive over dot-extensions. Non-image extensions resolve
// to nothing, so the binary-file guard keeps them (the negative case is load-bearing).
import { describe, test, expect } from 'bun:test';
import { encode as encodeJpeg } from 'jpeg-js';
import { ImageDecoders, type DecodedImage } from './ImageDecoders';
import { JpegDecoder } from './JpegDecoder';

describe('ImageDecoders', () => {
  test('supports exactly the registered raster extensions, case-insensitively', () => {
    for (const extension of ['.png', '.jpg', '.jpeg', '.PNG', '.JPG', '.Jpeg']) {
      expect(ImageDecoders.Class.supports(extension)).toBe(true);
    }
    for (const extension of ['.gif', '.bmp', '.webp', '.ts', '.md', '.bin', '', 'png']) {
      expect(ImageDecoders.Class.supports(extension)).toBe(false);
    }
  });

  test('decoderFor returns null for unsupported extensions', () => {
    expect(ImageDecoders.Class.decoderFor('.gif')).toBeNull();
    expect(ImageDecoders.Class.decoderFor('')).toBeNull();
  });

  test('the .jpg and .jpeg decoder decodes a real JPEG byte stream to the contract shape', () => {
    const width = 8;
    const height = 8;
    const frame = new Uint8Array(width * height * 4);
    for (let offset = 0; offset < frame.length; offset += 4) {
      frame[offset] = 200;
      frame[offset + 1] = 40;
      frame[offset + 2] = 40;
      frame[offset + 3] = 255;
    }
    const jpegBytes = new Uint8Array(encodeJpeg({ data: frame, width, height }, 95).data);
    for (const extension of ['.jpg', '.JPEG']) {
      const decoder = ImageDecoders.Class.decoderFor(extension);
      expect(decoder).not.toBeNull();
      const image = decoder!(jpegBytes);
      expect(image.width).toBe(width);
      expect(image.height).toBe(height);
      expect(image.rgba.length).toBe(width * height * 4);
    }
  });

  test('REGRESSION (review arch 11): the registry dereferences .Class at CALL time — a swap is honored', () => {
    // The registry must store delegating closures, never module-init snapshots of X.Class.decode:
    // swapping the decoder Class slot after import must change what the registry decodes with.
    const originalJpegClass = JpegDecoder.Class;
    class $FakeJpegDecoder {
      static decode = (): DecodedImage => ({ width: 1, height: 1, rgba: new Uint8Array([9, 9, 9, 255]) });
    }
    try {
      JpegDecoder.Class = $FakeJpegDecoder;
      const decoder = ImageDecoders.Class.decoderFor('.jpg');
      const image = decoder!(new Uint8Array([0, 1, 2]));
      expect(image.width).toBe(1);
      expect(Array.from(image.rgba)).toEqual([9, 9, 9, 255]);
    } finally {
      JpegDecoder.Class = originalJpegClass;
    }
  });

  test('the .png decoder rejects JPEG bytes and vice versa (honest per-format instances)', () => {
    const pngDecoder = ImageDecoders.Class.decoderFor('.png');
    const jpegDecoder = ImageDecoders.Class.decoderFor('.jpg');
    expect(pngDecoder).not.toBeNull();
    expect(jpegDecoder).not.toBeNull();
    const jpegBytes = new Uint8Array(
      encodeJpeg({ data: new Uint8Array(4 * 4 * 4).fill(255), width: 4, height: 4 }, 95).data,
    );
    expect(() => pngDecoder!(jpegBytes)).toThrow();
    const pngSignatureOnly = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(() => jpegDecoder!(pngSignatureOnly)).toThrow();
  });
});
