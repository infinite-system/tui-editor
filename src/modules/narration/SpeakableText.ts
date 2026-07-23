// Turns an assistant turn's RAW MARKDOWN into text fit to speak aloud. Piper (and espeak) spell out
// markdown punctuation, paths, and CODE letter-by-letter — "`/tmp/wt-voice`" becomes "slash-tee-em-pee…"
// and "`get hasDocument() { return ref(false) }`" becomes "open-paren close-paren open-brace…", the
// garble the user heard. This pure transform strips the markup, simplifies paths, and makes inline code
// SPEAKABLE (a code expression → the word "code"; an identifier → its split words) BEFORE the text
// reaches tts.speak(). Pure + deterministic: string → string, exhaustively unit-testable.
//
// invariant: Narration speaks prose, not markdown syntax (src/modules/narration/narration.invariants.md)
// invariant: Inline code is spoken as words, not symbols (src/modules/narration/narration.invariants.md)
import { Static } from 'ivue/extras';

/** Recognized source/file extensions — dropped from a spoken name (`Editor.ts` → `Editor`). A closed
 *  list so prose abbreviations ("e.g") are never truncated. */
const CODE_EXTENSION = /\.(ts|tsx|js|jsx|mjs|cjs|md|json|onnx|sh|py|rb|go|rs|c|cc|cpp|h|hpp|css|scss|html|vue|txt|yml|yaml|toml)$/i;

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

/** Drop a trailing KNOWN file extension so a filename reads as a name, not "dot tee-ess". */
function dropExtension(token: string): string {
  return token.replace(CODE_EXTENSION, '');
}

/** True when inline code is a CODE EXPRESSION piper would spell symbol-by-symbol — it has brackets or
 *  operators, or several stray symbols. Such spans are spoken as the single word "code" (reading
 *  `get hasDocument() {…}` aloud is hopeless; "code" is comprehensible). */
function isCodeExpression(code: string): boolean {
  if (/[(){}[\];=<>]/.test(code)) return true;
  return (code.match(/[^\w\s./-]/g) ?? []).length >= 2; // stray symbols beyond word/path/identifier chars
}

/** Split camelCase / PascalCase / snake_case / kebab-case into spoken words: `hasDocument` → "has
 *  Document", `attachWordWrap` → "attach Word Wrap", `parseHTML` → "parse HTML". */
function splitWords(identifier: string): string {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase boundary
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // ACRONYMWord → ACRONYM Word
    .replace(/[_-]+/g, ' ') // snake_case / kebab-case
    .replace(/\s+/g, ' ')
    .trim();
}

/** A BARE (un-backticked) prose token worth splitting as a code identifier — MULTI-word camelCase (two+
 *  humps), snake_case, or a known code extension. The two-hump floor spares ordinary CamelCase brand
 *  words ("GitHub", "JavaScript", "iPhone" — one hump each) from being mangled. */
function isBareCodeIdentifier(token: string): boolean {
  const humps = (token.match(/[a-z][A-Z]/g) ?? []).length;
  return humps >= 2 || /[a-z]_[a-z]/i.test(token) || CODE_EXTENSION.test(token);
}

/** Inline code → speakable: a path to its last segment, a code EXPRESSION to the word "code", a plain
 *  identifier to its split words (extension dropped). */
function simplifyInlineCode(code: string): string {
  const trimmed = code.trim();
  if (!trimmed) return '';
  if (isPathLike(trimmed)) return dropExtension(lastSegment(trimmed));
  if (isCodeExpression(trimmed)) return 'code';
  return splitWords(dropExtension(trimmed));
}

/** A bare prose token made speakable while keeping any trailing punctuation flush: paths collapse,
 *  filenames drop their extension, and multi-word identifiers split — ordinary words pass through. */
function speakBareToken(token: string): string {
  const match = /^(.*?)([.,;:!?)\]]*)$/.exec(token);
  const core = match?.[1] ?? token;
  const trailing = match?.[2] ?? '';
  if (!core) return token;
  if (isPathLike(core)) return dropExtension(lastSegment(core)) + trailing;
  if (isBareCodeIdentifier(core)) return splitWords(dropExtension(core)) + trailing;
  return token;
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
  // Bare (un-backticked) code-ish tokens in prose → speakable: paths collapse, filenames drop their
  // extension, multi-word identifiers split. Whitespace runs pass through untouched.
  text = text
    .split(/(\s+)/)
    .map((token) => (/\S/.test(token) ? speakBareToken(token) : token))
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
