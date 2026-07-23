// Turns an assistant turn's RAW MARKDOWN into text fit to speak aloud. Piper (and espeak) spell out
// markdown punctuation and paths letter-by-letter — "`/tmp/wt-voice`" becomes "slash-tee-em-pee-slash…",
// the "bebebe" babble the user heard. This pure transform strips the markup and simplifies paths BEFORE
// the text reaches tts.speak(), so narration reads the prose, not the syntax. Pure + deterministic: no
// engine, no state — just string → string, exhaustively unit-testable.
//
// invariant: Narration speaks prose, not markdown syntax (src/modules/narration/narration.invariants.md)
import { Static } from 'ivue/extras';

/** A whitespace-delimited token that reads as a filesystem path (so it should be spoken as its last
 *  segment, not spelled slash-by-slash): starts with `/`, `~`, or `.`, OR has two+ path separators.
 *  A single-slash token like "and/or" is NOT a path — it stays intact. */
function isPathLike(token: string): boolean {
  const slashes = (token.match(/\//g) ?? []).length;
  if (slashes === 0) return false;
  if (/^[~./]/.test(token)) return true;
  return slashes >= 2;
}

/** The last meaningful segment of a path-like token, trailing punctuation trimmed (`/tmp/wt-voice.` →
 *  `wt-voice`). */
function lastSegment(token: string): string {
  const cleaned = token.replace(/[.,;:!?)\]]+$/, '');
  const parts = cleaned.split('/').filter((part) => part.length > 0);
  return parts.length > 0 ? (parts[parts.length - 1] as string) : cleaned;
}

/** Inline code content spoken as-is, except a path collapses to its last segment. */
function simplifyInlineCode(code: string): string {
  const trimmed = code.trim();
  return isPathLike(trimmed) ? lastSegment(trimmed) : trimmed;
}

function toSpeakable(markdown: string): string {
  let text = markdown;
  // Fenced code blocks are unspeakable — announce them as a placeholder instead of reading the source.
  text = text.replace(/```[\s\S]*?```/g, ' code block ');
  // Inline code → its content (paths collapsed), never the backticks. No padding — punctuation that
  // follows the closing backtick (e.g. a period) must stay flush.
  text = text.replace(/`([^`]+)`/g, (_match, code: string) => simplifyInlineCode(code));
  // Images + links → their visible text.
  text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Headings, list bullets, blockquote markers → drop the leading markers (line-anchored).
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '');
  text = text.replace(/^\s*>\s?/gm, '');
  // Emphasis wrappers → the inner text.
  text = text.replace(/(\*\*|__)(.+?)\1/g, '$2');
  text = text.replace(/(\*|_)(.+?)\1/g, '$2');
  // Bare path tokens in prose → their last segment (so absolute paths aren't spelled out).
  text = text
    .split(/(\s+)/)
    .map((token) => (isPathLike(token) ? lastSegment(token) : token))
    .join('');
  // Collapse the now-uneven whitespace into a single spoken stream.
  return text.replace(/\s+/g, ' ').trim();
}

class $SpeakableText {
  /** Strip markdown + simplify paths so the text reads naturally aloud. Returns '' for empty input. */
  static forSpeech = toSpeakable;
}

export namespace SpeakableText {
  export const $Class = $SpeakableText;
  export const Class = Static($SpeakableText);
}
