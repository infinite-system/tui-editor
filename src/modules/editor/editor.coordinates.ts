// Text coordinate model. A document line is a JS string (UTF-16 internally). Three coordinates
// that do NOT coincide, each used by a different consumer:
//   - grapheme index  : the user-perceived character position — the cursor's "col". Editing moves
//                        and deletes by whole graphemes (never splits a surrogate pair or a
//                        base+combining cluster).
//   - UTF-16 offset   : index into the string, for slicing (and for LSP after mapping).
//   - display column  : terminal columns — tab-expanded and wide/zero-width aware, for the caret
//                        and rendering.
// invariant: A cursor position resolves to three distinct coordinates (editor.invariants.md)

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** UTF-16 boundary offsets: [0, end-of-g0, end-of-g1, ...]. Length = graphemeCount + 1. */
export function graphemeBoundaries(line: string): number[] {
  const b: number[] = [0];
  for (const seg of segmenter.segment(line)) {
    b.push(seg.index + seg.segment.length);
  }
  return b;
}

/** The grapheme cluster strings of a line, in order. */
export function graphemes(line: string): string[] {
  const out: string[] = [];
  for (const seg of segmenter.segment(line)) out.push(seg.segment);
  return out;
}

/** Number of user-perceived characters (grapheme clusters) in a line. */
export function graphemeCount(line: string): number {
  return graphemeBoundaries(line).length - 1;
}

/** UTF-16 offset of the start of grapheme `g` (clamped to [0, count]). */
export function graphemeToU16(line: string, g: number): number {
  const b = graphemeBoundaries(line);
  const i = Math.max(0, Math.min(g, b.length - 1));
  return b[i] ?? 0;
}

/** Grapheme index containing (or ending at) a UTF-16 offset. */
export function u16ToGrapheme(line: string, u16: number): number {
  const b = graphemeBoundaries(line);
  let g = 0;
  for (let i = 0; i < b.length; i++) {
    if ((b[i] ?? Infinity) <= u16) g = i;
    else break;
  }
  return g;
}

/** Display width of a single Unicode scalar (approximate wcwidth). */
export function codePointWidth(cp: number): number {
  if (cp === 0) return 0;
  // Combining marks / zero-width joiners / BOM.
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0x200b ||
    (cp >= 0x200c && cp <= 0x200f) ||
    cp === 0xfeff
  ) {
    return 0;
  }
  // Wide (East Asian Wide/Fullwidth) + most emoji.
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Display width of a grapheme cluster (its widest base scalar; a cluster is at least 1). */
export function graphemeWidth(g: string): number {
  let w = 0;
  for (const ch of g) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    const cw = codePointWidth(cp);
    if (cw > w) w = cw;
  }
  return w === 0 ? 1 : w;
}

/** Display column at the start of grapheme `g` (tab stops every `tabWidth`). */
export function displayColumn(line: string, g: number, tabWidth = 4): number {
  const gs = graphemes(line);
  const limit = Math.max(0, Math.min(g, gs.length));
  let col = 0;
  for (let i = 0; i < limit; i++) {
    const s = gs[i] ?? '';
    if (s === '\t') col += tabWidth - (col % tabWidth);
    else col += graphemeWidth(s);
  }
  return col;
}

/** Total display width of a whole line. */
export function lineWidth(line: string, tabWidth = 4): number {
  return displayColumn(line, graphemeCount(line), tabWidth);
}

/** Clamp a grapheme column to a line's valid range [0, graphemeCount]. */
export function clampCol(line: string, g: number): number {
  return Math.max(0, Math.min(g, graphemeCount(line)));
}
