import { Static } from 'ivue/extras';
import { EditorCoordinates } from './EditorCoordinates';

export interface PreviousWordDeletion {
  text: string;
  start: number;
  end: number;
}

class $TextEditing {
  // invariant: Word deletion uses the navigation boundary (src/modules/editor/editor.invariants.md)
  static wordLeft = $wordLeft;
  static deletePreviousWord = $deletePreviousWord;
}

export namespace TextEditing {
  export const $Class = $TextEditing;
  export const Class = Static($TextEditing);
}

type TextClusterKind = 'lineBreak' | 'whitespace' | 'word' | 'punctuation';

function $clusterKind(cluster: string): TextClusterKind {
  if (/^(?:\r\n|\r|\n)$/u.test(cluster)) return 'lineBreak';
  if (/^\s+$/u.test(cluster)) return 'whitespace';
  if (/[\p{L}\p{N}_]/u.test(cluster)) return 'word';
  return 'punctuation';
}

/**
 * Return the grapheme position at the previous word-delete boundary.
 *
 * Whitespace immediately left of the cursor is skipped first, then one homogeneous run of word or
 * punctuation clusters is crossed. A newline is a hard, single-cluster boundary: from the beginning
 * of a line the previous position is the preceding line end, so deletion joins lines without also
 * removing text from the preceding line.
 */
function $wordLeft(text: string, cursor: number): number {
  const clusters = EditorCoordinates.Class.graphemes(text);
  let position = Math.max(0, Math.min(cursor, clusters.length));
  if (position === 0) return 0;

  if ($clusterKind(clusters[position - 1] ?? '') === 'lineBreak') return position - 1;

  while (position > 0 && $clusterKind(clusters[position - 1] ?? '') === 'whitespace') {
    position -= 1;
  }
  if (position === 0 || $clusterKind(clusters[position - 1] ?? '') === 'lineBreak') return position;

  const runKind = $clusterKind(clusters[position - 1] ?? '');
  while (position > 0 && $clusterKind(clusters[position - 1] ?? '') === runKind) {
    position -= 1;
  }
  return position;
}

function $deletePreviousWord(
  text: string,
  cursor = EditorCoordinates.Class.graphemeCount(text),
): PreviousWordDeletion {
  const end = Math.max(0, Math.min(cursor, EditorCoordinates.Class.graphemeCount(text)));
  const start = $wordLeft(text, end);
  const startUtf16Offset = EditorCoordinates.Class.graphemeToU16(text, start);
  const endUtf16Offset = EditorCoordinates.Class.graphemeToU16(text, end);
  return {
    text: text.slice(0, startUtf16Offset) + text.slice(endUtf16Offset),
    start,
    end,
  };
}
