// The thinking indicator — Invar's personality in the busy state. It composes the animated "working…"
// line from the busy-only animation clock (frame index + elapsed seconds): EXACTLY ONE braille glyph at
// the FRONT (a fixed single-width cell, so the text after it never reflows), an IBR-flavoured status WORD
// that rotates every few seconds (reduction verbs — the app's soul), a per-character gradient SHIMMER
// that sweeps a highlight band across the word, a gradient PALETTE that switches with each word, and a
// dim elapsed-seconds counter. The "sparkle" is a brightness TWINKLE ON that single glyph (a colour
// pulse), never an extra glyph — a second front glyph would shift the whole line. No trailing glyph.
// Pure: state in, styled segments out (the renderer paints per-cell fg — bg spans mis-position).
// Capability fallback: truecolor shimmers smoothly, lower tiers degrade to a 2-colour band, ascii drops
// to a plain word. Everything ticks ONLY while busy (the animator is torn down at idle → idle quiescence).
import { Static } from 'ivue/extras';
import type { Palette } from '../theme/ThemePalettes';
import type { GlyphLevel, ColorDepth } from '../theme/TerminalCapabilities';
import { AgentSpinnerFrames } from './AgentSpinnerFrames';

/** One painted piece of the thinking line: text + fg colour + weight. */
export interface ThinkingSegment {
  readonly text: string;
  readonly color: string;
  readonly bold: boolean;
}

export interface ThinkingState {
  /** The ~10 Hz animation frame index (from the spinner animator). */
  frameIndex: number;
  /** Whole seconds since the busy spell began. */
  elapsedSeconds: number;
  glyphLevel: GlyphLevel;
  colorDepth: ColorDepth;
  palette: Palette;
}

/** The calm secondary "what it's blocked on" note — the CURRENTLY-DISPLAYED pending tool (the pane
 *  cycles through them over time), with that tool's own elapsed seconds. */
export interface WaitingNoteState {
  /** The pending tool to show now (null = nothing pending → no note). */
  toolName: string | null;
  /** Whole seconds THIS pending call has been outstanding. */
  elapsedSeconds: number;
  /** How many tools are pending in total (so a cycling display can hint "1/3"). */
  pendingCount: number;
  /** True briefly right after the display switches to another pending tool — a gentle pulse. */
  highlight: boolean;
  glyphLevel: GlyphLevel;
  palette: Palette;
}

// The IBR-soul rotation — the FINAL, user-LOCKED word list (a curated seam of delight). Do not edit the
// strings without the same sign-off. The core set rotates while busy; the easter-eggs surface rarely
// (~1 in 15 picks) as a discovery.
const CORE_WORDS = [
  'Reducing…',
  'Distilling…',
  'Carving away…',
  'Collapsing the space…',
  'Converging…',
  'Generating…',
  'Synthesizing…',
  'Triangulating…',
  'Grounding in reality…',
  'Scoping…',
  'Testing invariance…',
  'Refining…',
  'Isolating what remains…',
  'Testing boundaries…',
  'Auditing…',
  'Breaking assumptions…',
  'Reframing…',
  'Finding the invariant…',
  'Crystallizing…',
] as const;

/** Rare easter-eggs — surfaced ~1-in-EASTER_EGG_ODDS picks. */
const EASTER_EGGS = [
  'Quantum-hopping the solution space…',
  'Consulting the negative space…',
  'Deleting what refuses to matter…',
  'Quantizing the ineffable…',
  'Two-axis Auditing…',
  'Approaching the limit…',
] as const;

/** One in this many rotation slots surfaces an easter-egg instead of a core word. */
const EASTER_EGG_ODDS = 15;

/** Seconds each word holds before the next rotates in (~2.5–3.5s band; a steady 3s). */
const WORD_ROTATE_SECONDS = 3;

/** Deterministic per-slot word pick: mostly the core rotation, ~1/EASTER_EGG_ODDS an easter-egg. Pure
 *  (a slot index in, a word out) so the frequency is unit-testable. */
function $pickWord(slot: number): string {
  // Salt so slot 0 is not degenerate (hash(0) would be 0 → an egg every session-start); Knuth
  // multiplicative then scatters the eggs pseudo-randomly across slots.
  const hash = Math.imul((slot >>> 0) + 0x9e3779b9, 2654435761) >>> 0;
  if (hash % EASTER_EGG_ODDS === 0) return EASTER_EGGS[(hash >>> 8) % EASTER_EGGS.length]!;
  return CORE_WORDS[slot % CORE_WORDS.length]!;
}

/** Gradient palettes (base → highlight) cycled per word — derived from theme accents, never hardcoded
 *  colours. Each entry names two Palette roles; the shimmer sweeps between them. */
const GRADIENT_SCHEMES: ReadonlyArray<readonly [keyof Palette, keyof Palette]> = [
  ['func', 'operator'], // blue → teal
  ['type', 'number'], // yellow → orange
  ['keyword', 'error'], // purple → pink
  ['string', 'type'], // green → yellow
  ['number', 'error'], // orange → pink
];

/** The glyph twinkles (brightens toward the crest fg) ~2 of every 12 frames — a colour pulse on the
 *  ONE glyph, never an extra glyph cell. */
function twinkleGlyphColor(frameIndex: number, highlightColor: string, brightColor: string): string {
  return frameIndex % 12 < 2 ? brightColor : highlightColor;
}

function $compose(state: ThinkingState): ThinkingSegment[] {
  const { frameIndex, elapsedSeconds, glyphLevel, colorDepth, palette } = state;

  // The primary line always shows the agent WORKING — a rotating reduction verb with a shimmer; what
  // it's blocked on (a pending tool) lives in the calm secondary note, not here.
  const slot = Math.floor(Math.max(0, elapsedSeconds) / WORD_ROTATE_SECONDS);
  const word = $pickWord(slot);

  // The gradient palette switches with each slot (visual variety as the words change).
  const scheme = GRADIENT_SCHEMES[slot % GRADIENT_SCHEMES.length]!;
  const baseColor = palette[scheme[0]] as string;
  const highlightColor = palette[scheme[1]] as string;

  const glyph = AgentSpinnerFrames.Class.glyphFor(frameIndex, glyphLevel);
  const characters = Array.from(word);
  const shimmer =
    glyphLevel === 'ascii'
      ? characters.map(() => highlightColor) // ascii: plain (single colour) word
      : AgentSpinnerFrames.Class.shimmerColors(characters.length, frameIndex, colorDepth, baseColor, highlightColor);

  const segments: ThinkingSegment[] = [];
  // EXACTLY ONE front glyph (a single-width braille cell at a fixed column), twinkling by COLOUR — the
  // word after it always starts at the same column, so the line never reflows.
  segments.push({ text: glyph, color: twinkleGlyphColor(frameIndex, highlightColor, palette.fg), bold: true });
  segments.push({ text: ' ', color: palette.dim, bold: false });
  // The shimmering word, one segment per glyph so each carries its own gradient colour.
  characters.forEach((character, index) => {
    segments.push({ text: character, color: shimmer[index] ?? highlightColor, bold: true });
  });
  // Dim elapsed-seconds counter (trailing TEXT, never a glyph).
  segments.push({ text: `  ${AgentSpinnerFrames.Class.formatElapsed(elapsedSeconds)}`, color: palette.dim, bold: false });
  return segments;
}

/** The calm secondary note: which pending tool the agent is blocked on, with that tool's elapsed time.
 *  The pane cycles `toolName` through the pending set over time; a "2/3" counter hints there are more.
 *  Dim/informative (not shimmering), with a gentle pulse on switch. Empty when nothing is pending. */
function $composeWaitingNote(state: WaitingNoteState): ThinkingSegment[] {
  if (!state.toolName) return [];
  const glyph = state.glyphLevel === 'ascii' ? '*' : '⧗';
  const ellipsis = state.glyphLevel === 'ascii' ? '...' : '…';
  const glyphColor = state.highlight ? state.palette.accent : state.palette.info; // pulse on switch
  const segments: ThinkingSegment[] = [
    { text: `${glyph} `, color: glyphColor, bold: state.highlight },
    { text: state.toolName, color: state.palette.info, bold: false },
    { text: `${ellipsis} ${AgentSpinnerFrames.Class.formatElapsed(state.elapsedSeconds)}`, color: state.palette.dim, bold: false },
  ];
  if (state.pendingCount > 1) {
    // Which of the N pending calls this is (cycling); the pane sets highlight on the switch frame.
    segments.push({ text: `  (${state.pendingCount} pending)`, color: state.palette.dim, bold: false });
  }
  return segments;
}

class $AgentThinkingIndicator {
  static compose = $compose;
  static composeWaitingNote = $composeWaitingNote;
  /** The per-slot word pick (mostly core, ~1/EASTER_EGG_ODDS an easter-egg) — exposed for tests. */
  static pickWord = $pickWord;
  static readonly coreWords = CORE_WORDS;
  static readonly easterEggs = EASTER_EGGS;
  static readonly easterEggOdds = EASTER_EGG_ODDS;
}

export namespace AgentThinkingIndicator {
  export const $Class = $AgentThinkingIndicator;
  export const Class = Static($AgentThinkingIndicator);
}
