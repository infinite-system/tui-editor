// The spinner's PURE frame vocabulary: which glyph a given frame index shows at each fallback tier, and
// the label for a given session status. Split from the animator so the sequencing is unit-testable with
// no timer — frame index in, glyph out. The braille cycle is the high tier; a rotating ascii bar is the
// low-glyph fallback so a no-unicode terminal still animates.
//
// invariant: Terminal color and glyph support varies (project.invariants.md)
import { Static } from 'ivue/extras';
import type { GlyphLevel } from '../theme/TerminalCapabilities';
import type { AgentStatus } from './AgentEvents';

/** The braille spinner cycle (unicode/nerd tiers). */
const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'] as const;
/** The ascii fallback cycle (low glyph tier). */
const ASCII_FRAMES = ['|', '/', '-', '\\'] as const;

/** The glyph for `frameIndex` at the given tier (wraps by the tier's cycle length). */
function $glyphFor(frameIndex: number, glyphLevel: GlyphLevel): string {
  const frames = glyphLevel === 'ascii' ? ASCII_FRAMES : BRAILLE_FRAMES;
  const normalized = ((frameIndex % frames.length) + frames.length) % frames.length;
  return frames[normalized] ?? frames[0];
}

/** The label beside the spinner: "Thinking…" while streaming, "Running <tool>…" while a tool runs. */
function $labelFor(status: AgentStatus, runningToolName: string | null, glyphLevel: GlyphLevel): string {
  const ellipsis = glyphLevel === 'ascii' ? '...' : '…';
  if (status === 'awaiting-tool') return runningToolName ? `Running ${runningToolName}${ellipsis}` : `Running${ellipsis}`;
  return `Thinking${ellipsis}`;
}

class $AgentSpinnerFrames {
  static glyphFor = $glyphFor;
  static labelFor = $labelFor;
}

export namespace AgentSpinnerFrames {
  export const $Class = $AgentSpinnerFrames;
  export const Class = Static($AgentSpinnerFrames);
}
