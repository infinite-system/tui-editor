// Debug observation channel: dump OpenTUI's own render buffer (the source of truth, before the
// pty) as JSON so tests can assert VISUAL output per cell — char + packed fg/bg/attrs. This exists
// because `tmux capture-pane -e` is lossy for truecolor backgrounds; the framebuffer is exact.
// Gated by env (TUI_FRAME_DUMP=1) so it costs nothing in normal runs. The bg/fg values are the
// engine's packed 16-bit representation — not hex — but they are STABLE, so equality/inequality
// across cells is all a visual assertion needs (e.g. "these columns differ from their neighbours").
import { writeFileSync } from 'node:fs';
import { Static } from './Static';

export interface FrameRow {
  y: number;
  text: string;
  bg: number[];
  fg: number[];
  attrs: number[];
}

export interface FrameDump {
  width: number;
  height: number;
  rows: FrameRow[];
}

/** Minimal shape we read off `renderer.currentRenderBuffer` — kept structural to avoid a hard dep. */
interface CellBuffers {
  char: { length: number; [i: number]: number };
  fg: { [i: number]: number };
  bg: { [i: number]: number };
  attributes: { [i: number]: number };
}
interface BufferLike {
  width: number;
  height: number;
  buffers: CellBuffers;
}
interface RendererLike {
  currentRenderBuffer: BufferLike;
}

class $FrameProbe {
  /** Whether frame dumping is enabled (env-gated so production runs pay nothing). */
  static get enabled(): boolean {
    return process.env.TUI_FRAME_DUMP === '1';
  }

  /** Read the current render buffer into a plain, serializable grid. */
  static read(renderer: RendererLike): FrameDump {
    const buf = renderer.currentRenderBuffer;
    const { width, height } = buf;
    const { char, fg, bg, attributes } = buf.buffers;
    const rows: FrameRow[] = [];
    for (let y = 0; y < height; y++) {
      let text = '';
      const bgRow: number[] = [];
      const fgRow: number[] = [];
      const attrRow: number[] = [];
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        // `char` packs metadata (glyph width) in high bits; the codepoint is the low 21 bits.
        const cp = (char[i] ?? 0) & 0x1fffff;
        text += cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ' ';
        bgRow.push(bg[i] ?? 0);
        fgRow.push(fg[i] ?? 0);
        attrRow.push(attributes[i] ?? 0);
      }
      rows.push({ y, text: text.replace(/\s+$/, ''), bg: bgRow, fg: fgRow, attrs: attrRow });
    }
    return { width, height, rows };
  }

  /** Dump the current render buffer to `path` as JSON. No-op unless `enabled`. */
  static dump(renderer: RendererLike, path: string): void {
    if (!this.enabled) return;
    try {
      writeFileSync(path, JSON.stringify(this.read(renderer)));
    } catch {
      /* observability never crashes the app */
    }
  }
}

export namespace FrameProbe {
  export const $Class = $FrameProbe;
  export const Class = Static($FrameProbe);
}
