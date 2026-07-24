// The spinner's PURE frame vocabulary: which glyph a given frame index shows at each fallback tier, and
// the label for a given session status. Split from the animator so the sequencing is unit-testable with
// no timer — frame index in, glyph out. The braille cycle is the high tier; a rotating ascii bar is the
// low-glyph fallback so a no-unicode terminal still animates.
//
// invariant: Terminal color and glyph support varies (project.invariants.md)
import { Static } from 'ivue/extras';
import type { GlyphLevel, ColorDepth } from '../theme/TerminalCapabilities';
import { ThemeIcons } from '../theme/ThemeIcons';
import type { AgentStatus } from './AgentEvents';

// The frame cycles and the ellipsis come from the theme's AgentTranscriptIconSet ladder — no
// private glyph ladders in this module.
// invariant: Appearance is data with a capability fallback (project.invariants.md)

/** The glyph for `frameIndex` at the given tier (wraps by the tier's cycle length). */
function $glyphFor(frameIndex: number, glyphLevel: GlyphLevel): string {
  const frames = ThemeIcons.Class.agentTranscriptIconsFor(glyphLevel).spinnerFrames;
  const normalized = ((frameIndex % frames.length) + frames.length) % frames.length;
  return frames[normalized] ?? frames[0]!;
}

/** The label beside the spinner: "Thinking…" while streaming, "Running <tool>…" while a tool runs. */
function $labelFor(status: AgentStatus, runningToolName: string | null, glyphLevel: GlyphLevel): string {
  const ellipsis = ThemeIcons.Class.agentTranscriptIconsFor(glyphLevel).ellipsis;
  if (status === 'awaiting-tool') return runningToolName ? `Running ${runningToolName}${ellipsis}` : `Running${ellipsis}`;
  return `Thinking${ellipsis}`;
}

/** Format elapsed busy time: "12s" under a minute, "1m 05s" past it. */
function $formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder.toString().padStart(2, '0')}s`;
}

/** Parse "#rrggbb" → [r, g, b]; returns null when it is not a 6-digit hex. */
function parseHex(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) return null;
  const value = parseInt(match[1]!, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}
function toHex([r, g, b]: [number, number, number]): string {
  const clamp = (channel: number) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0');
  return `#${clamp(r)}${clamp(g)}${clamp(b)}`;
}

/** Wavelength (chars) and per-frame phase advance of the shimmer band. */
const SHIMMER_WAVELENGTH = 6;
const SHIMMER_PHASE_PER_FRAME = 0.55;

/** Per-character fg colours for a shimmer that SWEEPS a highlight band across `length` glyphs over time.
 *  Truecolor interpolates smoothly between base and highlight; lower tiers degrade to a 2-colour band
 *  (highlight on the crest, base elsewhere) so a 16-colour terminal still animates. */
function $shimmerColors(
  length: number,
  frameIndex: number,
  colorDepth: ColorDepth,
  baseColor: string,
  highlightColor: string,
): string[] {
  const base = parseHex(baseColor);
  const highlight = parseHex(highlightColor);
  const phase = frameIndex * SHIMMER_PHASE_PER_FRAME;
  const colors: string[] = [];
  for (let index = 0; index < length; index += 1) {
    // A cosine crest travels along the word as `phase` grows (t in [0,1], peak = highlight).
    const t = 0.5 + 0.5 * Math.cos(((index - phase) * (2 * Math.PI)) / SHIMMER_WAVELENGTH);
    if (colorDepth === 'truecolor' && base && highlight) {
      colors.push(toHex([
        base[0] + (highlight[0] - base[0]) * t,
        base[1] + (highlight[1] - base[1]) * t,
        base[2] + (highlight[2] - base[2]) * t,
      ]));
    } else {
      colors.push(t > 0.6 ? highlightColor : baseColor); // 2-colour band on low tiers
    }
  }
  return colors;
}

class $AgentSpinnerFrames {
  static glyphFor = $glyphFor;
  static labelFor = $labelFor;
  static formatElapsed = $formatElapsed;
  static shimmerColors = $shimmerColors;
}

export namespace AgentSpinnerFrames {
  export const $Class = $AgentSpinnerFrames;
  export const Class = Static($AgentSpinnerFrames);
}
