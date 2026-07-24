// Shared pointer-selection behavior for every text viewport. The host supplies coordinate mapping,
// selection-model writes, and scroll writes; this class owns only the pointer drag lifecycle and
// edge-rate integration. The normal editor and read-only diff panes therefore cannot drift into
// separate drag/autoscroll rules.

export interface SelectionDragPosition {
  line: number;
  column: number;
}

export interface SelectionDragViewportRectangle {
  leftColumn: number;
  rightColumn: number;
  topRow: number;
  bottomRow: number;
}

export interface SelectionDragBehaviorOptions {
  viewportRectangle: () => SelectionDragViewportRectangle;
  positionAtCell: (screenColumn: number, screenRow: number) => SelectionDragPosition | null;
  horizontalScrollPosition: () => number;
  horizontalScrollingEnabled: () => boolean;
  beginSelection: (position: SelectionDragPosition, pointerDisplayColumn: number) => void;
  extendSelection: (position: SelectionDragPosition, pointerDisplayColumn: number) => void;
  finishSelection: () => void;
  scrollColumns: (columnDelta: number) => void;
  scrollRows: (rowDelta: number) => void;
  haltCompetingScroll: () => void;
  // Grapheme count of a document line, used to make a rightward drag INCLUSIVE of the character
  // under the release cell (terminal cells are whole; the caret otherwise lands before that char,
  // dropping the last letter of a word). Omit to keep the caret-exact half-open behavior.
  lineGraphemeCount?: (lineIndex: number) => number;
}

class $SelectionDragBehavior {
  private pointerPosition: { screenColumn: number; screenRow: number } | null = null;
  private selectionAnchor: SelectionDragPosition | null = null;
  private columnScrollRemainder = 0;
  private rowScrollRemainder = 0;

  constructor(private readonly options: SelectionDragBehaviorOptions) {}

  get active(): boolean {
    return this.pointerPosition !== null;
  }

  begin(screenColumn: number, screenRow: number): void {
    const position = this.options.positionAtCell(screenColumn, screenRow);
    if (!position) return;
    this.options.haltCompetingScroll();
    this.pointerPosition = { screenColumn, screenRow };
    this.selectionAnchor = position;
    this.columnScrollRemainder = 0;
    this.rowScrollRemainder = 0;
    this.options.beginSelection(position, this.pointerDisplayColumn(screenColumn));
  }

  drag(screenColumn: number, screenRow: number): void {
    if (!this.pointerPosition) return;
    this.pointerPosition = { screenColumn, screenRow };
    const position = this.options.positionAtCell(screenColumn, screenRow);
    if (!position) return;
    this.options.extendSelection(this.inclusiveHead(position), this.pointerDisplayColumn(screenColumn));
  }

  end(): void {
    if (!this.pointerPosition) return;
    this.pointerPosition = null;
    this.selectionAnchor = null;
    this.columnScrollRemainder = 0;
    this.rowScrollRemainder = 0;
    this.options.finishSelection();
  }

  // Terminal mouse reports whole cells, so a drag has no sub-cell side. Placing the head caret at
  // the grapheme UNDER the release cell yields a half-open range that drops the final character —
  // most visible when the line is scrolled fully right and the pointer sits on the last char. When
  // the head is at or past the anchor (a rightward/downward drag) advance it one grapheme so the
  // character under the release cell is INCLUDED, clamped to the line's end-of-line caret.
  private inclusiveHead(position: SelectionDragPosition): SelectionDragPosition {
    const anchor = this.selectionAnchor;
    const lineGraphemeCount = this.options.lineGraphemeCount;
    if (!anchor || !lineGraphemeCount) return position;
    const headAtOrAfterAnchor =
      position.line > anchor.line ||
      (position.line === anchor.line && position.column >= anchor.column);
    if (!headAtOrAfterAnchor) return position;
    return {
      line: position.line,
      column: Math.min(position.column + 1, lineGraphemeCount(position.line)),
    };
  }

  /** Advance edge autoscroll by one frame. True keeps the demand-driven frame clock alive. */
  tick(deltaTimeSeconds: number): boolean {
    const pointerPosition = this.pointerPosition;
    if (!pointerPosition) return false;
    const viewportRectangle = this.options.viewportRectangle();
    const columnOvershoot = this.overshoot(
      pointerPosition.screenColumn,
      viewportRectangle.leftColumn,
      viewportRectangle.rightColumn,
    );
    const rowOvershoot = this.overshoot(
      pointerPosition.screenRow,
      viewportRectangle.topRow,
      viewportRectangle.bottomRow,
    );
    if (columnOvershoot === 0 && rowOvershoot === 0) {
      this.columnScrollRemainder = 0;
      this.rowScrollRemainder = 0;
      return false;
    }

    if (this.options.horizontalScrollingEnabled() && columnOvershoot !== 0) {
      this.columnScrollRemainder += this.cellsPerSecond(columnOvershoot) * deltaTimeSeconds;
    } else {
      this.columnScrollRemainder = 0;
    }
    this.rowScrollRemainder += rowOvershoot === 0
      ? 0
      : this.cellsPerSecond(rowOvershoot) * deltaTimeSeconds;

    const columnStep = Math.trunc(this.columnScrollRemainder);
    const rowStep = Math.trunc(this.rowScrollRemainder);
    this.columnScrollRemainder -= columnStep;
    this.rowScrollRemainder -= rowStep;
    if (columnStep !== 0) this.options.scrollColumns(columnStep);
    if (rowStep !== 0) this.options.scrollRows(rowStep);

    const clampedScreenColumn = Math.max(
      viewportRectangle.leftColumn,
      Math.min(pointerPosition.screenColumn, viewportRectangle.rightColumn),
    );
    const clampedScreenRow = Math.max(
      viewportRectangle.topRow,
      Math.min(pointerPosition.screenRow, viewportRectangle.bottomRow),
    );
    const position = this.options.positionAtCell(clampedScreenColumn, clampedScreenRow);
    if (position) {
      this.options.extendSelection(this.inclusiveHead(position), this.pointerDisplayColumn(clampedScreenColumn));
    }
    return true;
  }

  private pointerDisplayColumn(screenColumn: number): number {
    const viewportRectangle = this.options.viewportRectangle();
    return Math.max(
      0,
      this.options.horizontalScrollPosition() + screenColumn - viewportRectangle.leftColumn,
    );
  }

  private overshoot(pointerCoordinate: number, minimumCoordinate: number, maximumCoordinate: number): number {
    if (pointerCoordinate >= maximumCoordinate) return pointerCoordinate - maximumCoordinate + 1;
    if (pointerCoordinate <= minimumCoordinate) return pointerCoordinate - minimumCoordinate - 1;
    return 0;
  }

  private cellsPerSecond(overshoot: number): number {
    return Math.sign(overshoot) * Math.min(120, 25 + 18 * (Math.abs(overshoot) - 1));
  }
}

export namespace SelectionDragBehavior {
  export const $Class = $SelectionDragBehavior;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
