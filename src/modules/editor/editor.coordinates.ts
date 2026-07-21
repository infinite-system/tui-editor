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
  const boundaries: number[] = [0];
  for (const segment of segmenter.segment(line)) {
    boundaries.push(segment.index + segment.segment.length);
  }
  return boundaries;
}

/** The grapheme cluster strings of a line, in order. */
export function graphemes(line: string): string[] {
  const clusters: string[] = [];
  for (const segment of segmenter.segment(line)) clusters.push(segment.segment);
  return clusters;
}

/** Number of user-perceived characters (grapheme clusters) in a line. */
export function graphemeCount(line: string): number {
  return graphemeBoundaries(line).length - 1;
}

/** UTF-16 offset of the start of grapheme `g` (clamped to [0, count]). */
export function graphemeToU16(line: string, graphemeIndex: number): number {
  const boundaries = graphemeBoundaries(line);
  const index = Math.max(0, Math.min(graphemeIndex, boundaries.length - 1));
  return boundaries[index] ?? 0;
}

/** Grapheme index containing (or ending at) a UTF-16 offset. */
export function u16ToGrapheme(line: string, utf16Offset: number): number {
  const boundaries = graphemeBoundaries(line);
  let graphemeIndex = 0;
  for (let index = 0; index < boundaries.length; index++) {
    if ((boundaries[index] ?? Infinity) <= utf16Offset) graphemeIndex = index;
    else break;
  }
  return graphemeIndex;
}

/** Display width of a single Unicode scalar (approximate wcwidth). */
export function codePointWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  // Combining marks / zero-width joiners / BOM.
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    codePoint === 0x200b ||
    (codePoint >= 0x200c && codePoint <= 0x200f) ||
    codePoint === 0xfeff
  ) {
    return 0;
  }
  // Wide (East Asian Wide/Fullwidth) + most emoji.
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Display width of a grapheme cluster (its widest base scalar; a cluster is at least 1). */
export function graphemeWidth(grapheme: string): number {
  let width = 0;
  for (const character of grapheme) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    const characterWidth = codePointWidth(codePoint);
    if (characterWidth > width) width = characterWidth;
  }
  return width === 0 ? 1 : width;
}

/** Display column at the start of grapheme `graphemeIndex` (tab stops every `tabWidth`). */
export function displayColumn(line: string, graphemeIndex: number, tabWidth = 4): number {
  const clusters = graphemes(line);
  const limit = Math.max(0, Math.min(graphemeIndex, clusters.length));
  let column = 0;
  for (let index = 0; index < limit; index++) {
    const cluster = clusters[index] ?? '';
    if (cluster === '\t') column += tabWidth - (column % tabWidth);
    else column += graphemeWidth(cluster);
  }
  return column;
}

/** Total display width of a whole line. */
export function lineWidth(line: string, tabWidth = 4): number {
  return displayColumn(line, graphemeCount(line), tabWidth);
}

/** Clamp a grapheme column to a line's valid range [0, graphemeCount]. */
export function clampCol(line: string, column: number): number {
  return Math.max(0, Math.min(column, graphemeCount(line)));
}
