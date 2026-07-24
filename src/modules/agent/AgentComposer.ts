// The agent COMPOSER: the editable input line, the second instance of the shared text surface (the
// transcript is the first). It WRAPS its buffer to the pane width (never overflowing horizontally under a
// neighbour pane), GROWS up to a small cap, then SCROLLS internally to keep the CURSOR line visible. It
// owns a real CURSOR (a grapheme index into the text) with full mid-text editing — insert/delete at the
// cursor, char/word/line motion — reusing the shared TextEditing word boundaries and TextSelectionModel +
// WrapText seams, so nothing is re-implemented. Enter (handled by the pane) sends the whole buffer.
import { ref, type Ref } from 'vue';
import { WrapText } from '../ui/WrapText';
import { TextSelectionModel, type SelectionPoint, type SelectionSpanRange } from '../ui/TextSelectionModel';
import { TextEditing } from '../editor/TextEditing';
import { EditorCoordinates } from '../editor/EditorCoordinates';
import { Clipboard } from '../system/Clipboard';

/** Max visual rows the composer grows to before it scrolls internally (keeps the cursor line visible). */
export const COMPOSER_MAX_ROWS = 5;
/** The prompt gutter width ("❯ " on line 1, "  " on continuations) reserved on every composer row. */
export const COMPOSER_GUTTER_COLUMNS = 2;

/** One laid-out composer row: its absolute visual-line index, gutter prefix, text, and selection span. */
export interface ComposerRow {
  readonly absoluteLine: number;
  readonly isFirstLine: boolean;
  readonly text: string;
  readonly selection: SelectionSpanRange | null;
}

/** The composer's laid-out geometry for one frame (rows to paint + where the caret sits). */
export interface ComposerLayout {
  readonly rows: ComposerRow[];
  /** Visible row count (1..COMPOSER_MAX_ROWS) — how many bottom rows the composer occupies. */
  readonly rowCount: number;
  /** Caret cell, relative to the composer's first visible row: row within [0, rowCount), display column. */
  readonly caretRow: number;
  readonly caretColumn: number;
}

class $AgentComposer {
  private readonly buffer = ref('');
  private readonly selection = new TextSelectionModel.Class();
  /** The cursor as a GRAPHEME index into the buffer (0..length) — the single source of edit position. */
  private cursorIndex = 0;
  /** Last frame's wrap width + scroll offset — the coord space for caret / pointer / selection mapping. */
  private lastWrapWidth = 1;
  private scrollOffset = 0;
  /** Cached wrap segments for (buffer, width) — every geometry read derives from ONE segmentation. */
  private cachedSegments: readonly import('../ui/WrapText').WrapSegment[] | null = null;
  private cachedSegmentsText = '';
  private cachedSegmentsWidth = 0;

  /** The reactive buffer text (the pane fuses its length into the render revision). */
  get text(): Ref<string> {
    return this.buffer;
  }
  get value(): string {
    return this.buffer.value;
  }
  get isEmpty(): boolean {
    return this.buffer.value.length === 0;
  }
  /** The cursor's grapheme index (for tests / assertions). */
  get cursor(): number {
    return this.cursorIndex;
  }

  private graphemes(): string[] {
    return EditorCoordinates.Class.graphemes(this.buffer.value);
  }
  private graphemeCount(): number {
    return EditorCoordinates.Class.graphemeCount(this.buffer.value);
  }
  private clampCursor(): number {
    return Math.max(0, Math.min(this.cursorIndex, this.graphemeCount()));
  }

  // --- editing (all at the CURSOR; every edit clears the selection) ----------------------------------

  /** Insert typed text AT the cursor. Newlines flatten to spaces (the composer is one logical line that
   *  sends on Enter). The cursor advances past the inserted text. */
  insert(text: string): void {
    const flattened = text.replace(/\r\n?|\n/g, ' ');
    if (!flattened) return;
    const graphemes = this.graphemes();
    const inserted = EditorCoordinates.Class.graphemes(flattened);
    const cursor = this.clampCursor();
    this.buffer.value = [...graphemes.slice(0, cursor), ...inserted, ...graphemes.slice(cursor)].join('');
    this.cursorIndex = cursor + inserted.length;
    this.selection.clear();
  }
  /** Delete the grapheme BEFORE the cursor (Backspace). */
  backspace(): void {
    const cursor = this.clampCursor();
    if (cursor === 0) return;
    const graphemes = this.graphemes();
    this.buffer.value = [...graphemes.slice(0, cursor - 1), ...graphemes.slice(cursor)].join('');
    this.cursorIndex = cursor - 1;
    this.selection.clear();
  }
  /** Delete the grapheme AT the cursor (Delete/forward-delete). */
  deleteForward(): void {
    const cursor = this.clampCursor();
    const graphemes = this.graphemes();
    if (cursor >= graphemes.length) return;
    this.buffer.value = [...graphemes.slice(0, cursor), ...graphemes.slice(cursor + 1)].join('');
    this.selection.clear();
  }
  /** Delete the WORD before the cursor (Alt/Option+Backspace) — cursor-aware via the shared seam. */
  deletePreviousWord(): void {
    const cursor = this.clampCursor();
    if (cursor === 0) return;
    const result = TextEditing.Class.deletePreviousWord(this.buffer.value, cursor);
    this.buffer.value = result.text;
    this.cursorIndex = result.start;
    this.selection.clear();
  }
  /** Clear the whole current logical line (Ctrl/Cmd+Backspace) — the composer is one logical line. */
  deleteLine(): void {
    if (this.buffer.value.length === 0) return;
    this.buffer.value = '';
    this.cursorIndex = 0;
    this.selection.clear();
  }
  /** Empty the buffer (after a send). */
  clear(): void {
    this.buffer.value = '';
    this.cursorIndex = 0;
    this.selection.clear();
  }

  // --- cursor motion (all clear the selection) -------------------------------------------------------

  moveLeft(): void {
    this.cursorIndex = Math.max(0, this.clampCursor() - 1);
    this.selection.clear();
  }
  moveRight(): void {
    this.cursorIndex = Math.min(this.graphemeCount(), this.clampCursor() + 1);
    this.selection.clear();
  }
  moveWordLeft(): void {
    this.cursorIndex = TextEditing.Class.wordLeft(this.buffer.value, this.clampCursor());
    this.selection.clear();
  }
  moveWordRight(): void {
    this.cursorIndex = TextEditing.Class.wordRight(this.buffer.value, this.clampCursor());
    this.selection.clear();
  }
  moveHome(): void {
    this.cursorIndex = 0;
    this.selection.clear();
  }
  moveEnd(): void {
    this.cursorIndex = this.graphemeCount();
    this.selection.clear();
  }
  /** Move the cursor UP one visual line at the same column. Returns false when already on the first
   *  visual line (the host then falls through to transcript scroll). */
  moveUp(): boolean {
    const caret = this.caretVisual();
    if (caret.line <= 0) return false;
    this.cursorIndex = this.positionAt(caret.line - 1, caret.column);
    this.selection.clear();
    return true;
  }
  /** Move the cursor DOWN one visual line. Returns false when already on the last visual line. */
  moveDown(): boolean {
    const caret = this.caretVisual();
    if (caret.line >= this.numVisualLines() - 1) return false;
    this.cursorIndex = this.positionAt(caret.line + 1, caret.column);
    this.selection.clear();
    return true;
  }

  // --- visual geometry (cursor ↔ wrapped row/DISPLAY-cell column, through the WrapText seam) ---------
  // The buffer is one logical line (newlines flatten on insert), so buffer grapheme indices align 1:1
  // with the seam's whole-text offsets. All geometry derives from ONE segments() call per state — the
  // uniform-width index/width math this replaces disagreed with rendered rows on wide/combining text
  // (the reviewed éx caret divergence).

  /** The wrapped segments for the CURRENT buffer at the last layout width (cached per state). */
  private segments(): readonly import('../ui/WrapText').WrapSegment[] {
    if (this.cachedSegments === null || this.cachedSegmentsText !== this.buffer.value || this.cachedSegmentsWidth !== this.lastWrapWidth) {
      this.cachedSegments = WrapText.Class.segments(this.buffer.value, Math.max(1, this.lastWrapWidth));
      this.cachedSegmentsText = this.buffer.value;
      this.cachedSegmentsWidth = this.lastWrapWidth;
    }
    return this.cachedSegments;
  }
  private numVisualLines(): number {
    return Math.max(1, this.segments().length);
  }
  /** DISPLAY-cell width of a visual row. */
  private visualLineLength(lineIndex: number): number {
    return this.segments()[lineIndex]?.displayWidth ?? 0;
  }
  /** The cursor's visual (row, DISPLAY-cell column) in the wrapped composer. */
  private caretVisual(): { line: number; column: number } {
    return WrapText.Class.visualPositionOf(this.segments(), this.clampCursor());
  }
  /** The grapheme index at a visual (row, DISPLAY-cell column), snapped to a cluster start. */
  private positionAt(lineIndex: number, column: number): number {
    return Math.min(this.graphemeCount(), WrapText.Class.graphemeAtVisualPosition(this.segments(), lineIndex, column));
  }

  /** Lay the composer out for `paneWidth` columns: wrap, cap the row count, scroll to keep the CURSOR
   *  line visible, mark selection spans, and place the caret at the cursor's visual cell. */
  layout(paneWidth: number): ComposerLayout {
    this.lastWrapWidth = Math.max(1, paneWidth - COMPOSER_GUTTER_COLUMNS);
    const segments = this.segments();

    const totalLines = Math.max(1, segments.length);
    const rowCount = Math.max(1, Math.min(totalLines, COMPOSER_MAX_ROWS));
    const caret = this.caretVisual();

    // Scroll minimally to keep the caret line visible (persisted between frames — natural scrolling).
    const maximumOffset = Math.max(0, totalLines - rowCount);
    if (caret.line < this.scrollOffset) this.scrollOffset = caret.line;
    else if (caret.line > this.scrollOffset + rowCount - 1) this.scrollOffset = caret.line - rowCount + 1;
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maximumOffset));

    const rows: ComposerRow[] = [];
    for (let visibleIndex = 0; visibleIndex < rowCount; visibleIndex += 1) {
      const absoluteLine = this.scrollOffset + visibleIndex;
      const segment = segments[absoluteLine];
      rows.push({
        absoluteLine,
        isFirstLine: absoluteLine === 0,
        text: segment?.text ?? '',
        selection: this.selection.rangeForLine(absoluteLine, segment?.displayWidth ?? 0),
      });
    }

    return {
      rows,
      rowCount,
      caretRow: Math.max(0, Math.min(caret.line - this.scrollOffset, rowCount - 1)),
      caretColumn: COMPOSER_GUTTER_COLUMNS + caret.column,
    };
  }

  // --- selection (reuses the shared model; the host maps screen cells → these composer coords) --------

  /** Map a composer-local cell (column already pane-relative, row within the visible composer rows) to a
   *  selection point in the composer's full visual-line space. */
  pointAt(localColumn: number, visibleRow: number): SelectionPoint {
    const line = this.scrollOffset + Math.max(0, visibleRow);
    const column = Math.max(0, localColumn - COMPOSER_GUTTER_COLUMNS);
    return { line, column };
  }
  beginSelection(point: SelectionPoint): void {
    this.selection.begin(point);
  }
  extendSelection(point: SelectionPoint): void {
    this.selection.extend(point);
  }
  finishSelection(): void {
    this.selection.finish();
  }
  clearSelection(): boolean {
    return this.selection.clear();
  }
  hasSelection(): boolean {
    return this.selection.hasSelection();
  }
  lineGraphemeCount(lineIndex: number): number {
    return this.visualLineLength(lineIndex);
  }
  /** Rows the composer currently occupies (for the host's screen-region check). */
  get rowCount(): number {
    return Math.max(1, Math.min(this.numVisualLines(), COMPOSER_MAX_ROWS));
  }

  /** The selected buffer text — through the SEAM's resolver-based reconstruction (the composer no
   *  longer suppresses the shared selectedText): each covered row slices grapheme-safely by DISPLAY
   *  cells, and rows join with '' because composer wraps concatenate (no phantom newlines). */
  selectedText(): string {
    const segments = this.segments();
    return this.selection.selectedText((line, startCell, endCell) => {
      const segment = segments[line];
      if (!segment) return null;
      return WrapText.Class.sliceByDisplayCells(segment.text, startCell, endCell ?? Number.MAX_SAFE_INTEGER);
    }, '');
  }

  /** Copy the composer selection to the OS clipboard; resolves to the character count copied. */
  async copySelection(): Promise<number> {
    const text = this.selectedText();
    if (!text) return 0;
    await Clipboard.Class.copy(text);
    return text.length;
  }
}

export namespace AgentComposer {
  export const $Class = $AgentComposer;
  export let Class = $Class;
  export type Model = InstanceType<typeof Class>;
}
