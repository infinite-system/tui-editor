// The agent COMPOSER: the editable input line, distilled as the second instance of the shared text
// surface (the transcript is the first). It WRAPS its buffer to the pane width (never overflowing
// horizontally under a neighbour pane — the bug this fixes), GROWS up to a small cap, then SCROLLS
// internally to keep the caret line visible (caret is always at the end — append/backspace editing, no
// mid-text cursor). It is SELECTABLE/COPYABLE through the same TextSelectionModel + shared WrapText the
// transcript uses — one selection/wrap seam, two surfaces, no bespoke re-implementation.
import { ref, type Ref } from 'vue';
import { WrapText } from '../ui/WrapText';
import { TextSelectionModel, type SelectionPoint, type SelectionSpanRange } from '../ui/TextSelectionModel';
import { TextEditing } from '../editor/TextEditing';
import { Clipboard } from '../system/Clipboard';

/** Max visual rows the composer grows to before it scrolls internally (keeps the caret line visible). */
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
  /** Last frame's full wrapped lines + scroll offset — the coord space for pointer/selection mapping. */
  private lastVisualLines: string[] = [''];
  private lastScrollOffset = 0;
  private lastWrapWidth = 1;

  /** The reactive buffer text (the pane fuses its length into the render revision). */
  get text(): Ref<string> {
    return this.buffer;
  }
  /** The current buffer string. */
  get value(): string {
    return this.buffer.value;
  }
  get isEmpty(): boolean {
    return this.buffer.value.length === 0;
  }

  /** Append typed text at the caret (end). Newlines flatten to spaces — the composer sends on Enter, so
   *  a stored newline would break the single-logical-line model. Clears any selection (an edit). */
  insert(text: string): void {
    const flattened = text.replace(/\r\n?|\n/g, ' ');
    if (!flattened) return;
    this.buffer.value += flattened;
    this.selection.clear();
  }
  /** Delete the last character (append/backspace-at-end editing). */
  backspace(): void {
    if (this.buffer.value.length === 0) return;
    this.buffer.value = Array.from(this.buffer.value).slice(0, -1).join('');
    this.selection.clear();
  }
  /** Delete the last WORD (Alt/Option+Backspace) via the shared word-boundary seam every text input uses.
   *  Caret is at the end, so deleting from the whole value removes the trailing word. */
  deletePreviousWord(): void {
    if (this.buffer.value.length === 0) return;
    this.buffer.value = TextEditing.Class.deletePreviousWord(this.buffer.value).text;
    this.selection.clear();
  }
  /** Empty the buffer (after a send). */
  clear(): void {
    this.buffer.value = '';
    this.selection.clear();
  }

  /** Lay the composer out for `paneWidth` columns: wrap to the inner width, cap the row count, scroll to
   *  keep the caret (end) visible, and mark the selection span on each row. */
  layout(paneWidth: number): ComposerLayout {
    const wrapWidth = Math.max(1, paneWidth - COMPOSER_GUTTER_COLUMNS);
    const visualLines = WrapText.Class.wrap(this.buffer.value, wrapWidth);
    this.lastVisualLines = visualLines;
    this.lastWrapWidth = wrapWidth;

    const totalLines = visualLines.length;
    const rowCount = Math.max(1, Math.min(totalLines, COMPOSER_MAX_ROWS));
    // Caret is at the end, so anchor the window to the BOTTOM (show the last `rowCount` lines).
    const scrollOffset = Math.max(0, totalLines - rowCount);
    this.lastScrollOffset = scrollOffset;

    const rows: ComposerRow[] = [];
    for (let visibleIndex = 0; visibleIndex < rowCount; visibleIndex += 1) {
      const absoluteLine = scrollOffset + visibleIndex;
      const text = visualLines[absoluteLine] ?? '';
      rows.push({
        absoluteLine,
        isFirstLine: absoluteLine === 0,
        text,
        selection: this.selection.rangeForLine(absoluteLine, Array.from(text).length),
      });
    }

    const lastLineLength = Array.from(visualLines[totalLines - 1] ?? '').length;
    return {
      rows,
      rowCount,
      caretRow: rowCount - 1,
      caretColumn: COMPOSER_GUTTER_COLUMNS + lastLineLength,
    };
  }

  // --- selection (reuses the shared model; the host maps screen cells → these composer coords) --------

  /** Map a composer-local cell (column already pane-relative, row within the visible composer rows) to a
   *  selection point in the composer's full visual-line space. */
  pointAt(localColumn: number, visibleRow: number): SelectionPoint {
    const line = this.lastScrollOffset + Math.max(0, visibleRow);
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
    return Array.from(this.lastVisualLines[lineIndex] ?? '').length;
  }
  /** Rows the composer currently occupies (for the host's screen-region check). */
  get rowCount(): number {
    return Math.max(1, Math.min(this.lastVisualLines.length, COMPOSER_MAX_ROWS));
  }

  /** The selected buffer text — reconstructed from CODE-POINT offsets (wrap adds no separators, so the
   *  visual lines concatenate back to the buffer with NO phantom newlines, unlike the transcript). */
  selectedText(): string {
    const span = this.selection.normalized();
    if (!span) return '';
    const codePoints = Array.from(this.buffer.value);
    const offsetOf = (point: SelectionPoint): number => {
      let offset = 0;
      for (let line = 0; line < point.line; line += 1) offset += Array.from(this.lastVisualLines[line] ?? '').length;
      return Math.min(codePoints.length, offset + point.column);
    };
    return codePoints.slice(offsetOf(span[0]), offsetOf(span[1])).join('');
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
