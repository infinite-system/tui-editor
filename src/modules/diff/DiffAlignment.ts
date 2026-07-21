// Pure line alignment for side-by-side differences. The output row sequence is the shared
// coordinate space for both panes: a missing line is represented by a filler on that side, never
// by letting the panes acquire independent row offsets.
//
// invariant: Both panes share every aligned row (src/modules/diff/diff.invariants.md)
// invariant: Replace hunks pair before adding fillers (src/modules/diff/diff.invariants.md)
import { Static } from 'ivue/extras';

export type AlignedRowKind = 'equal' | 'modified' | 'added' | 'deleted';

export interface AlignedRow {
  readonly kind: AlignedRowKind;
  readonly leftLineNumber: number | null;
  readonly rightLineNumber: number | null;
}

/** An aligned-row interval with an inclusive start and exclusive end. */
export interface ChangeBlock {
  readonly startAlignedRowIndex: number;
  readonly endAlignedRowIndexExclusive: number;
}

export interface DiffAlignmentResult {
  readonly alignedRows: readonly AlignedRow[];
  readonly changeBlocks: readonly ChangeBlock[];
}

type EditOperation =
  | { readonly kind: 'equal'; readonly leftLineIndex: number; readonly rightLineIndex: number }
  | { readonly kind: 'deleted'; readonly leftLineIndex: number }
  | { readonly kind: 'added'; readonly rightLineIndex: number };

function $splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split(/\r?\n/);
}

function frontierPosition(frontier: ReadonlyMap<number, number>, diagonal: number): number {
  return frontier.get(diagonal) ?? Number.NEGATIVE_INFINITY;
}

/** Myers O((N+M)D) shortest edit script over line values. */
function shortestEditScript(previousLines: readonly string[], currentLines: readonly string[]): EditOperation[] {
  const maximumDistance = previousLines.length + currentLines.length;
  const frontier = new Map<number, number>();
  const frontierTrace: Array<Map<number, number>> = [];
  frontier.set(1, 0);

  for (let editDistance = 0; editDistance <= maximumDistance; editDistance++) {
    frontierTrace.push(new Map(frontier));
    for (let diagonal = -editDistance; diagonal <= editDistance; diagonal += 2) {
      const descendsFromAddition =
        diagonal === -editDistance ||
        (diagonal !== editDistance &&
          frontierPosition(frontier, diagonal - 1) < frontierPosition(frontier, diagonal + 1));
      let leftLineIndex = descendsFromAddition
        ? frontierPosition(frontier, diagonal + 1)
        : frontierPosition(frontier, diagonal - 1) + 1;
      let rightLineIndex = leftLineIndex - diagonal;

      while (
        leftLineIndex < previousLines.length &&
        rightLineIndex < currentLines.length &&
        previousLines[leftLineIndex] === currentLines[rightLineIndex]
      ) {
        leftLineIndex++;
        rightLineIndex++;
      }
      frontier.set(diagonal, leftLineIndex);

      if (leftLineIndex >= previousLines.length && rightLineIndex >= currentLines.length) {
        return backtrackEditScript(previousLines.length, currentLines.length, frontierTrace);
      }
    }
  }

  return [];
}

function backtrackEditScript(
  previousLineCount: number,
  currentLineCount: number,
  frontierTrace: readonly ReadonlyMap<number, number>[],
): EditOperation[] {
  const reversedOperations: EditOperation[] = [];
  let leftLineIndex = previousLineCount;
  let rightLineIndex = currentLineCount;

  for (let editDistance = frontierTrace.length - 1; editDistance >= 0; editDistance--) {
    const frontier = frontierTrace[editDistance]!;
    const diagonal = leftLineIndex - rightLineIndex;
    const previousDiagonal =
      diagonal === -editDistance ||
      (diagonal !== editDistance &&
        frontierPosition(frontier, diagonal - 1) < frontierPosition(frontier, diagonal + 1))
        ? diagonal + 1
        : diagonal - 1;
    const previousLeftLineIndex = frontierPosition(frontier, previousDiagonal);
    const previousRightLineIndex = previousLeftLineIndex - previousDiagonal;

    while (leftLineIndex > previousLeftLineIndex && rightLineIndex > previousRightLineIndex) {
      leftLineIndex--;
      rightLineIndex--;
      reversedOperations.push({ kind: 'equal', leftLineIndex, rightLineIndex });
    }

    if (editDistance === 0) break;
    if (leftLineIndex === previousLeftLineIndex) {
      rightLineIndex--;
      reversedOperations.push({ kind: 'added', rightLineIndex });
    } else {
      leftLineIndex--;
      reversedOperations.push({ kind: 'deleted', leftLineIndex });
    }
  }

  return reversedOperations.reverse();
}

function appendChangedHunk(
  alignedRows: AlignedRow[],
  deletedLineNumbers: readonly number[],
  addedLineNumbers: readonly number[],
): void {
  const pairedLineCount = Math.min(deletedLineNumbers.length, addedLineNumbers.length);
  for (let pairedLineIndex = 0; pairedLineIndex < pairedLineCount; pairedLineIndex++) {
    alignedRows.push({
      kind: 'modified',
      leftLineNumber: deletedLineNumbers[pairedLineIndex]!,
      rightLineNumber: addedLineNumbers[pairedLineIndex]!,
    });
  }
  for (let deletedLineIndex = pairedLineCount; deletedLineIndex < deletedLineNumbers.length; deletedLineIndex++) {
    alignedRows.push({
      kind: 'deleted',
      leftLineNumber: deletedLineNumbers[deletedLineIndex]!,
      rightLineNumber: null,
    });
  }
  for (let addedLineIndex = pairedLineCount; addedLineIndex < addedLineNumbers.length; addedLineIndex++) {
    alignedRows.push({
      kind: 'added',
      leftLineNumber: null,
      rightLineNumber: addedLineNumbers[addedLineIndex]!,
    });
  }
}

function alignedRowsFromOperations(operations: readonly EditOperation[]): AlignedRow[] {
  const alignedRows: AlignedRow[] = [];
  let operationIndex = 0;

  while (operationIndex < operations.length) {
    const operation = operations[operationIndex]!;
    if (operation.kind === 'equal') {
      alignedRows.push({
        kind: 'equal',
        leftLineNumber: operation.leftLineIndex + 1,
        rightLineNumber: operation.rightLineIndex + 1,
      });
      operationIndex++;
      continue;
    }

    const deletedLineNumbers: number[] = [];
    const addedLineNumbers: number[] = [];
    while (operationIndex < operations.length && operations[operationIndex]!.kind !== 'equal') {
      const changedOperation = operations[operationIndex]!;
      if (changedOperation.kind === 'deleted') deletedLineNumbers.push(changedOperation.leftLineIndex + 1);
      else if (changedOperation.kind === 'added') addedLineNumbers.push(changedOperation.rightLineIndex + 1);
      operationIndex++;
    }
    appendChangedHunk(alignedRows, deletedLineNumbers, addedLineNumbers);
  }

  return alignedRows;
}

function changeBlocksFromRows(alignedRows: readonly AlignedRow[]): ChangeBlock[] {
  const changeBlocks: ChangeBlock[] = [];
  let alignedRowIndex = 0;
  while (alignedRowIndex < alignedRows.length) {
    if (alignedRows[alignedRowIndex]!.kind === 'equal') {
      alignedRowIndex++;
      continue;
    }
    const startAlignedRowIndex = alignedRowIndex;
    while (alignedRowIndex < alignedRows.length && alignedRows[alignedRowIndex]!.kind !== 'equal') {
      alignedRowIndex++;
    }
    changeBlocks.push({ startAlignedRowIndex, endAlignedRowIndexExclusive: alignedRowIndex });
  }
  return changeBlocks;
}

function $align(previousVersionText: string, currentVersionText: string): DiffAlignmentResult {
  const previousLines = $splitLines(previousVersionText);
  const currentLines = $splitLines(currentVersionText);
  const alignedRows = alignedRowsFromOperations(shortestEditScript(previousLines, currentLines));
  return { alignedRows, changeBlocks: changeBlocksFromRows(alignedRows) };
}

function $nextChangeBlockStart(
  changeBlocks: readonly ChangeBlock[],
  alignedRowIndex: number,
): number | null {
  return changeBlocks.find((changeBlock) => changeBlock.startAlignedRowIndex > alignedRowIndex)
    ?.startAlignedRowIndex ?? null;
}

function $previousChangeBlockStart(
  changeBlocks: readonly ChangeBlock[],
  alignedRowIndex: number,
): number | null {
  for (let changeBlockIndex = changeBlocks.length - 1; changeBlockIndex >= 0; changeBlockIndex--) {
    const changeBlock = changeBlocks[changeBlockIndex]!;
    if (changeBlock.startAlignedRowIndex < alignedRowIndex) return changeBlock.startAlignedRowIndex;
  }
  return null;
}

class $DiffAlignment {
  static splitLines = $splitLines;
  static align = $align;
  static nextChangeBlockStart = $nextChangeBlockStart;
  static previousChangeBlockStart = $previousChangeBlockStart;
}

export namespace DiffAlignment {
  export const $Class = $DiffAlignment;
  export const Class = Static($DiffAlignment);
}
