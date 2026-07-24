// The image-preview seam RootView drives when the active buffer is an image file: it reads the file
// bytes, decodes them once per path via the ImageDecoders registry (PNG, JPEG — whatever the seam
// supports), and renders the half-block projection sized to the pane. Both
// stages are memoised — decode by path, and the rendered StyledText by (path, columns, rows,
// background) — so per-frame cost is a map lookup, never a re-decode of a multi-megapixel image. A
// decode failure is caught and shown as a friendly one-line message; the app never crashes on a bad or
// unsupported image. Plain stateful class (it owns caches, holds no reactive state): the frame effect
// that calls render() already re-runs when the active buffer or pane geometry changes.
//
// invariant: A raster image renders as half-block cells sized to the pane (src/modules/image/image.invariants.md)
import { StyledText, fg } from '@opentui/core';
import { Files } from '../system/Files';
import { ImageDecoders, type DecodedImage } from './ImageDecoders';
import { HalfBlockRenderer } from './HalfBlockRenderer';

/** A decoded image, or the error captured while decoding it (so the friendly message is stable). */
type DecodeOutcome = { image: DecodedImage } | { error: string };

class $ImagePreview {
  // Single-slot decode memo: the last decoded path and its outcome (a multi-megapixel decode is far too
  // costly to repeat per frame). A new active image replaces the slot.
  private decodedPath: string | null = null;
  private decodeOutcome: DecodeOutcome | null = null;
  // Single-slot render memo: the last rendered StyledText and the key that produced it.
  private renderKey = '';
  private renderedText: StyledText | null = null;

  /** Render the image at `path` into a StyledText sized to columns×rows, over the panel background. */
  render(path: string, columns: number, rows: number, panelBackground: string): StyledText {
    const key = `${path}:${columns}:${rows}:${panelBackground}`;
    if (key === this.renderKey && this.renderedText) return this.renderedText;
    const outcome = this.decode(path);
    const text =
      'error' in outcome
        ? new StyledText([fg('#e06c75')(`  Cannot preview this image — ${outcome.error}`)])
        : HalfBlockRenderer.Class.render({ image: outcome.image, columns, rows, panelBackground }).styledText;
    this.renderKey = key;
    this.renderedText = text;
    return text;
  }

  private decode(path: string): DecodeOutcome {
    if (path === this.decodedPath && this.decodeOutcome) return this.decodeOutcome;
    let outcome: DecodeOutcome;
    try {
      const extension = Files.Class.extname(path).toLowerCase();
      const decoder = ImageDecoders.Class.decoderFor(extension);
      if (!decoder) throw new Error(`no decoder registered for '${extension}' files`);
      const bytes = Files.Class.readBytes(path);
      outcome = { image: decoder(new Uint8Array(bytes)) };
    } catch (error) {
      outcome = { error: error instanceof Error ? error.message : String(error) };
    }
    this.decodedPath = path;
    this.decodeOutcome = outcome;
    return outcome;
  }
}

export namespace ImagePreview {
  export const $Class = $ImagePreview;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
