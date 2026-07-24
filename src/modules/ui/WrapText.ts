// The shared hard-wrap seam: split a string into visual lines no wider than `width` columns. One
// deterministic, width-exact implementation both text surfaces reuse (agent transcript = read-only,
// composer = editable), so their wrapping can never drift. Wraps on CODE POINTS (Array.from), never
// splitting an astral glyph (box-drawing/emoji) across a row boundary. Explicit newlines start a new
// visual line; an empty logical line yields one empty visual line (so blank lines are preserved).
//
// invariant: Seams are drawn at the shared generator (project.invariants.md)
import { Static } from 'ivue/extras';

function $wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    const codePoints = Array.from(rawLine);
    if (codePoints.length === 0) {
      out.push('');
      continue;
    }
    for (let start = 0; start < codePoints.length; start += width) {
      out.push(codePoints.slice(start, start + width).join(''));
    }
  }
  return out;
}

class $WrapText {
  static wrap = $wrap;
}

export namespace WrapText {
  export const $Class = $WrapText;
  export const Class = Static($WrapText);
}
