// The pixel-preview mount: the ONE stateful piece between the pure tier encoders and the terminal.
// It owns what is currently ON SCREEN (placement key, image id, the encoder that placed it) and the
// emission discipline: a placement is emitted only when its key (tier, path, fitted rect, background)
// actually changes — never per frame — and only AFTER the renderer settles, so the frame that blanks
// the cells under the graphics lands first and never repaints over a fresh sixel. A superseded
// placement is cancelled by generation, a replaced placement is deleted before the new one is placed,
// leaving the buffer deletes the placement, and dispose sweeps every placement — the app never leaks
// an image onto the user's shell after quit. Plain stateful class (no reactive state): the frame
// effect drives sync() and already re-runs on every input that could change the key.
//
// invariant: A pixel tier places and deletes graphics explicitly (src/modules/image/image.invariants.md)
// invariant: An image buffer replaces the code text and leaves other files untouched (src/modules/image/image.invariants.md)
import type { GraphicsTier } from '../theme/TerminalCapabilities';
import type { DecodedImage } from './ImageDecoders';
import type { PixelEncoder } from './ImageRenderers';
import { ImageResample } from './ImageResample';

/** The terminal surface the mount emits through — injectable so tests capture payloads. */
export interface PixelMountTerminal {
  /** Write an escape payload through the renderer's serialized output path (never mid-frame). */
  writePayload(data: string): void;
  /** Resolves after pending frames have flushed — placements are emitted only then. */
  afterFramesSettled(): Promise<void>;
  /** The terminal's cell size in pixels, or null when the terminal has not reported one. */
  cellPixelSize(): { width: number; height: number } | null;
}

/** One sync request: everything needed to decide whether and where to (re)place the active image. */
export interface PixelMountContext {
  tier: GraphicsTier;
  encoder: PixelEncoder;
  image: DecodedImage;
  path: string;
  /** The preview pane's cell rect (screen cells, 0-based). */
  region: { x: number; y: number; columns: number; rows: number };
  /** Panel background as `#rrggbb` — composited under transparency by pixel-resampling tiers. */
  panelBackground: string;
}

// The assumed cell size when the terminal reports none: 8×16 keeps the 1:2 cell aspect the
// half-block fit also assumes, so tier switches do not change the letterbox shape.
const FALLBACK_CELL_PIXEL_WIDTH = 8;
const FALLBACK_CELL_PIXEL_HEIGHT = 16;

/** Parse `#rrggbb` into [red, green, blue], black on a bad string. */
function parseHexBackground(hex: string): [number, number, number] {
  const normalized = hex.startsWith('#') ? hex.slice(1) : hex;
  const packed = Number.parseInt(normalized.slice(0, 6), 16);
  if (normalized.length < 6 || Number.isNaN(packed)) return [0, 0, 0];
  return [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff];
}

class $PixelImageMount {
  private placementKey = '';
  private placedImageId = 0; // 0 = nothing placed
  private placedEncoder: PixelEncoder | null = null;
  private nextImageId = 7001; // arbitrary base clear of small ids other tools might use
  private emitGeneration = 0;
  private disposeSweep = ''; // the removeAll payload of any identity-tracking encoder ever placed

  constructor(private terminal: PixelMountTerminal) {}

  /** Reconcile the on-screen placement with the requested one. Cheap when nothing changed. */
  sync(context: PixelMountContext): void {
    const cell = this.terminal.cellPixelSize() ?? {
      width: FALLBACK_CELL_PIXEL_WIDTH,
      height: FALLBACK_CELL_PIXEL_HEIGHT,
    };
    const { region, image } = context;
    const boxPixelWidth = Math.max(1, region.columns) * cell.width;
    const boxPixelHeight = Math.max(1, region.rows) * cell.height;
    const fitted = ImageResample.Class.fitWithin(image.width, image.height, boxPixelWidth, boxPixelHeight);
    const fittedColumns = Math.max(1, Math.min(region.columns, Math.round(fitted.width / cell.width)));
    const fittedRows = Math.max(1, Math.min(region.rows, Math.round(fitted.height / cell.height)));
    const key =
      `${context.tier}:${context.path}:${region.x}:${region.y}:${region.columns}:${region.rows}:` +
      `${fittedColumns}:${fittedRows}:${context.panelBackground}:${image.width}:${image.height}`;
    if (key === this.placementKey) return;

    // Build every payload NOW (pure work, stale-proof); emit after the frame settles.
    const removePrevious =
      this.placedEncoder && this.placedImageId ? this.placedEncoder.remove(this.placedImageId) : '';
    const imageId = this.nextImageId++;
    const placePayload = context.encoder.place({
      image,
      imageId,
      columns: fittedColumns,
      rows: fittedRows,
      pixelWidth: fitted.width,
      pixelHeight: fitted.height,
      background: parseHexBackground(context.panelBackground),
    });
    // Centre the fitted rect in the pane; CUP is 1-based. Cursor save/restore brackets the emit so
    // the placement never moves the app's real cursor.
    const cursorRow = region.y + Math.floor((region.rows - fittedRows) / 2) + 1;
    const cursorColumn = region.x + Math.floor((region.columns - fittedColumns) / 2) + 1;
    const payload = `${removePrevious}\x1b7\x1b[${cursorRow};${cursorColumn}H${placePayload}\x1b8`;

    this.placementKey = key;
    this.placedImageId = imageId;
    this.placedEncoder = context.encoder;
    const removeAll = context.encoder.removeAll();
    if (removeAll) this.disposeSweep = removeAll;

    const generation = ++this.emitGeneration;
    void this.terminal.afterFramesSettled().then(() => {
      if (generation !== this.emitGeneration) return; // superseded before it reached the screen
      this.terminal.writePayload(payload);
    });
  }

  /** The active buffer is no longer this image (or no longer pixel-rendered): delete the placement.
   *  Idempotent and cheap when nothing is placed. */
  clear(): void {
    this.emitGeneration++; // cancel any in-flight place
    if (this.placedEncoder && this.placedImageId) {
      const removePayload = this.placedEncoder.remove(this.placedImageId);
      if (removePayload) this.terminal.writePayload(removePayload);
    }
    this.placementKey = '';
    this.placedImageId = 0;
    this.placedEncoder = null;
  }

  /** App shutdown: delete the current placement and sweep all — nothing may outlive the app. */
  dispose(): void {
    this.clear();
    if (this.disposeSweep) {
      this.terminal.writePayload(this.disposeSweep);
      this.disposeSweep = '';
    }
  }
}

export namespace PixelImageMount {
  export const $Class = $PixelImageMount;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
