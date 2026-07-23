// The editor: owns a document, a cursor, and a viewport, and coordinates movement, selection,
// editing, and scroll.
//
// invariant: Data flows one way (project.invariants.md)
// invariant: Selection is an anchor plus the cursor and edits replace it (editor.invariants.md)
import { Reactive } from 'ivue';
import { ref, type Ref } from 'vue';
import { TextDocument } from './TextDocument';
import { Viewport } from './Viewport';
import { Cursor } from './Cursor';
import { EditorCoordinates } from './EditorCoordinates';
import { TextEditing } from './TextEditing';
import { EditorWrap } from './EditorWrap';
import { UndoStore, type EditKind } from '../storage/UndoStore';
import { Files } from '../system/Files';
import { Clock } from '../system/Clock';
import { Clipboard } from '../system/Clipboard';

class $Editor {
  // invariant: Construction goes through overridable seams (project.invariants.md)
  document = this.createDocument();
  viewport = this.createViewport();
  cursor = this.createCursor();
  private undo = this.createUndo();

  protected createDocument() { return new TextDocument.Class(); }
  protected createViewport() { return new Viewport.Class(); }
  protected createCursor() { return new Cursor.Class(); }
  protected createUndo() { return new UndoStore.Class(); }

  get hasDocument() {
    return ref(false);
  }
  get readOnly() {
    return ref(false);
  }
  // Word wrap is a VIEW MODE: when on, rendering/caret/selection route through the pure
  // logical↔visual mapping in editor.wrap.ts and horizontal scroll is inert. The document model
  // is untouched by the toggle. invariant: Word wrap is a pure view mapping (editor.invariants.md)
  // Word wrap is a GLOBAL view preference: EVERY editor instance reads the SAME settings.wordWrap ref
  // (attached via attachWordWrap), so the setting is the single source — the settings panel AND the
  // toggle command drive the identical ref, and switching tabs never desyncs the mode. Falls back to a
  // local ref only before a source is attached (bare unit tests).
  private wordWrapSource: Ref<boolean> | null = null;
  attachWordWrap(source: Ref<boolean>): void {
    this.wordWrapSource = source;
  }
  get wordWrap(): Ref<boolean> {
    return this.wordWrapSource ?? this.localWordWrap;
  }
  get localWordWrap() {
    return ref(false);
  }

  /** The display-column width visual rows wrap at (the laid-out code viewport width). */
  wrapWidth(): number {
    return Math.max(1, this.viewport.width.value);
  }

  toggleWordWrap(): void {
    this.wordWrap.value = !this.wordWrap.value;
    if (!this.hasDocument.value) return;
    if (this.wordWrap.value) {
      this.viewport.scrollLeft.value = 0; // horizontal scroll is inert in wrap mode
      this.revealCursorWrapped();
    } else {
      // Restore the absolute display-column goal and the caret-following horizontal scroll.
      this.placeCursor(this.cursor.line.value, this.cursor.col.value);
      this.scrollLineIntoView(this.cursor.line.value);
    }
  }

  // Wrap-mode reveal: scrollTop is a VISUAL-row index in wrap mode (so it shares the momentum engine +
  // the scrollbar reads visual extent), so the reveal is the plain min/max on the cursor's ABSOLUTE
  // visual row = (first visual row of its line) + (its segment within the line). This is what makes the
  // scroll reach the true last visual row: no logical-line quantization.
  private revealCursorWrapped(): void {
    const width = this.wrapWidth();
    const segments = EditorWrap.Class.wrapLine(this.document.line(this.cursor.line.value), width);
    const segmentIndex = EditorWrap.Class.segmentIndexForCursor(segments, this.cursor.col.value);
    const cursorVisualRow = EditorWrap.Class.firstVisualRowOfLine(this.document, this.cursor.line.value, width) + segmentIndex;
    const height = this.viewport.height.value;
    const top = this.viewport.scrollTop.value;
    const maximumTop = Math.max(0, EditorWrap.Class.totalVisualRows(this.document, width) - height);
    let next = top;
    if (cursorVisualRow < top) next = cursorVisualRow;
    else if (cursorVisualRow >= top + height) next = cursorVisualRow - height + 1;
    this.viewport.scrollTop.value = Math.max(0, Math.min(next, maximumTop));
  }

  /** Mode-aware vertical reveal: wrapped visual-row walk when wrap is on, logical otherwise. */
  private scrollLineIntoView(line: number): void {
    if (this.wordWrap.value) this.revealCursorWrapped();
    else this.viewport.scrollToLine(line, this.document.lineCount);
  }

  /**
   * Re-anchor the scroll on the cursor for the CURRENT wrap mode — called when word wrap is toggled (by
   * the command OR the settings panel), where viewport.scrollTop switches units (logical lines ↔ visual
   * rows). Revealing the cursor sets a valid scrollTop in the new units without a fragile unit
   * conversion, so the cursor stays on screen across the toggle.
   */
  revealCursor(): void {
    if (!this.hasDocument.value) return;
    this.scrollLineIntoView(this.cursor.line.value);
  }

  openFile(path: string): void {
    this.document.loadFromFile(path);
    this.placeCursor(0, 0);
    this.cursor.clearSelection();
    this.viewport.scrollTop.value = 0;
    this.hasDocument.value = true;
    this.readOnly.value = this.document.binary.value;
    this.undo.clear();
  }

  // --- LiveBuffer surface (the OpenBufferSet flyweight drives these) --------
  // A clean background tab is dehydrated to a light position handle and its document/undo/syntax are
  // released; on re-activation the set recreates the buffer and restores the handle. A DIRTY tab is
  // never dehydrated, so its unsaved edits survive.

  /** Dirty = the document has unsaved edits (drives the tab's dirty dot + the never-dehydrate rule). */
  get dirty(): boolean {
    return this.document.dirty.value;
  }

  /** Capture the resumable cursor + scroll position so this buffer can be dehydrated. */
  snapshotPosition(): { cursorLine: number; cursorColumn: number; scrollTop: number; scrollLeft: number } {
    return {
      cursorLine: this.cursor.line.value,
      cursorColumn: this.cursor.col.value,
      scrollTop: this.viewport.scrollTop.value,
      scrollLeft: this.viewport.scrollLeft.value,
    };
  }

  /** Restore a snapshot after rehydration (the file was just reloaded into a fresh document). */
  restorePosition(position: { cursorLine: number; cursorColumn: number; scrollTop: number; scrollLeft: number }): void {
    if (!this.hasDocument.value) return;
    this.placeCursor(position.cursorLine, position.cursorColumn);
    this.viewport.scrollTop.value = position.scrollTop;
    this.viewport.scrollLeft.value = position.scrollLeft;
  }

  /** Release the owned document text + undo history so a closed/dehydrated tab frees memory promptly
   *  (the Editor holds no external listeners/timers, so dropping these + the reference is complete). */
  dispose(): void {
    this.undo.clear();
    this.document.loadFromText('', '');
    this.hasDocument.value = false;
  }

  /** Open a VIRTUAL read-only diff document (git panel drill-in). */
  openDiff(displayPath: string, diffText: string): void {
    this.document.loadFromText(diffText, `${displayPath}.diff`);
    this.placeCursor(0, 0);
    this.cursor.clearSelection();
    this.viewport.scrollTop.value = 0;
    this.viewport.scrollLeft.value = 0;
    this.hasDocument.value = true;
    this.readOnly.value = true; // a diff is a VIEW; editing happens in the real file
    this.undo.clear();
  }

  // --- selection ------------------------------------------------------------

  get hasSelection(): boolean {
    return this.cursor.hasSelection;
  }

  selectionText(): string {
    const range = this.cursor.selectionRange();
    return range ? this.document.sliceRange(range.start, range.end) : '';
  }

  selectAll(): void {
    if (!this.hasDocument.value) return;
    const last = this.document.lineCount - 1;
    this.placeCursor(0, 0);
    this.cursor.setAnchorHere();
    this.placeCursor(last, EditorCoordinates.Class.graphemeCount(this.document.line(last)));
  }

  /** Select the word (run of word characters) at a document position — the double-click gesture. */
  selectWord(line: number, column: number): void {
    if (!this.hasDocument.value) return;
    const bounds = EditorCoordinates.Class.wordBounds(this.document.line(line), column);
    this.placeCursor(line, bounds.start);
    this.cursor.setAnchorHere();
    this.placeCursor(line, bounds.end);
  }

  /** Select the entire line (start → end) — the triple-click / click-again-on-selected-word gesture. */
  selectLine(line: number): void {
    if (!this.hasDocument.value) return;
    this.placeCursor(line, 0);
    this.cursor.setAnchorHere();
    this.placeCursor(line, EditorCoordinates.Class.graphemeCount(this.document.line(line)));
  }

  /** Delete from the cursor to the LINE START (text to the right of the cursor stays). With an active
   *  selection, delete the selection instead. Cmd/Ctrl+Backspace. */
  deleteToLineStart(): void {
    if (!this.hasDocument.value) return;
    if (this.hasSelection) {
      this.captureBefore('delete');
      this.removeSelection();
      this.scrollLineIntoView(this.cursor.line.value);
      return;
    }
    const line = this.cursor.line.value;
    const column = this.cursor.col.value;
    if (column === 0) return; // already at line start — nothing to the left on this line
    this.captureBefore('delete');
    this.document.deleteRange({ line, col: 0 }, { line, col: column });
    this.placeCursor(line, 0);
    this.scrollLineIntoView(line);
  }

  /** Delete the active selection (no undo capture — caller captures). Returns whether it removed. */
  private removeSelection(): boolean {
    const range = this.cursor.selectionRange();
    if (!range) return false;
    const position = this.document.deleteRange(range.start, range.end);
    this.placeCursor(position.line, position.col);
    this.cursor.clearSelection();
    return true;
  }

  /**
   * Place the cursor at a grapheme column, recording the matching DISPLAY column as the goal.
   * Wrap mode: the goal is the visual column WITHIN the cursor's wrapped row, horizontal scroll
   * stays inert, and the reveal moves by visual rows.
   */
  placeCursor(line: number, column: number): void {
    this.viewport.haltScrollMomentum(); // precise cursor move adopts authority, stops wheel glide
    const lineText = this.document.line(line);
    const absoluteDisplayColumn = EditorCoordinates.Class.displayColumn(lineText, column);
    if (this.wordWrap.value) {
      const segments = EditorWrap.Class.wrapLine(lineText, this.wrapWidth());
      const segment = segments[EditorWrap.Class.segmentIndexForCursor(segments, column)];
      this.cursor.set(line, column, absoluteDisplayColumn - (segment?.startDisplayColumn ?? 0));
      this.revealCursorWrapped();
      return;
    }
    this.cursor.set(line, column, absoluteDisplayColumn);
    this.viewport.scrollToColumn(absoluteDisplayColumn); // keep the caret horizontally visible
  }

  /** Set/extend the anchor for a movement (extend) or drop the selection (plain move). */
  private beginMove(extend: boolean): void {
    if (extend) {
      if (!this.cursor.anchor.value) this.cursor.setAnchorHere();
    } else {
      this.cursor.clearSelection();
    }
  }

  // --- editing --------------------------------------------------------------

  private captureBefore(kind: EditKind): void {
    this.undo.record(
      {
        lines: this.document.snapshot(),
        cursor: { line: this.cursor.line.value, col: this.cursor.col.value },
        kind,
        at: Clock.Class.now(),
      },
      Clock.Class.now(),
    );
  }

  insertText(text: string): void {
    if (this.readOnly.value || !this.hasDocument.value) return;
    this.captureBefore('insert');
    this.removeSelection();
    const column = this.document.insertInline(this.cursor.line.value, this.cursor.col.value, text);
    this.placeCursor(this.cursor.line.value, column);
    this.scrollLineIntoView(this.cursor.line.value);
  }

  insertNewline(): void {
    if (this.readOnly.value || !this.hasDocument.value) return;
    this.captureBefore('newline');
    this.removeSelection();
    // Auto-indent: copy leading whitespace of the current line.
    const currentLine = this.document.line(this.cursor.line.value);
    const indent = currentLine.match(/^\s*/)?.[0] ?? '';
    const position = this.document.splitLine(this.cursor.line.value, this.cursor.col.value);
    if (indent) {
      const column = this.document.insertInline(position.line, 0, indent);
      this.placeCursor(position.line, column);
    } else {
      this.placeCursor(position.line, position.col);
    }
    this.scrollLineIntoView(this.cursor.line.value);
  }

  backspace(): void {
    if (this.readOnly.value || !this.hasDocument.value) return;
    this.captureBefore('delete');
    if (this.removeSelection()) {
      this.scrollLineIntoView(this.cursor.line.value);
      return;
    }
    const position = this.document.deleteBackward(this.cursor.line.value, this.cursor.col.value);
    this.placeCursor(position.line, position.col);
    this.scrollLineIntoView(position.line);
  }

  deleteChar(): void {
    if (this.readOnly.value || !this.hasDocument.value) return;
    this.captureBefore('delete');
    if (this.removeSelection()) return;
    this.document.deleteForward(this.cursor.line.value, this.cursor.col.value);
  }

  /** Delete exactly [wordLeft(cursor), cursor], or the active selection, as one undo step. */
  deletePreviousWord(): void {
    if (this.readOnly.value || !this.hasDocument.value) return;
    if (this.hasSelection) {
      this.captureBefore('delete');
      this.removeSelection();
      this.scrollLineIntoView(this.cursor.line.value);
      return;
    }

    const deletionStart = this.previousWordPosition(true);
    if (
      deletionStart.line === this.cursor.line.value &&
      deletionStart.col === this.cursor.col.value
    ) {
      return;
    }

    this.captureBefore('delete');
    this.document.deleteRange(
      deletionStart,
      { line: this.cursor.line.value, col: this.cursor.col.value },
    );
    this.placeCursor(deletionStart.line, deletionStart.col);
    this.scrollLineIntoView(deletionStart.line);
  }

  // --- structural line edits (move / duplicate) -----------------------------
  // Each is ONE atomic undo step: captureBefore snapshots the whole document + cursor once, then the
  // mutation runs; performUndo restores that snapshot, so a single undo reverts the move/dup. Kind
  // 'other' never coalesces with a neighbouring edit, so a move is never merged into a typing run.
  // v1 SCOPE: these act on the CURSOR line only. Moving a multi-line SELECTION block as a unit (the VS
  // Code behaviour) is a flagged follow-up; a selection is dropped and the cursor line moves.
  // invariant: A structural line edit is one atomic undo step that keeps the cursor on the moved line (src/modules/editor/editor.invariants.md)

  /** Swap the cursor's line with the one above, keeping the cursor on the moved line. No-op at the top. */
  moveLineUp(): void {
    if (this.readOnly.value || !this.hasDocument.value) return;
    const line = this.cursor.line.value;
    if (line <= 0) return; // top edge: nothing above to swap with
    this.captureBefore('other');
    const above = this.document.line(line - 1);
    const moved = this.document.line(line);
    this.document.setLine(line - 1, moved);
    this.document.setLine(line, above);
    this.placeCursor(line - 1, EditorCoordinates.Class.clampCol(moved, this.cursor.col.value));
    this.cursor.clearSelection();
    this.scrollLineIntoView(line - 1);
  }

  /** Swap the cursor's line with the one below, keeping the cursor on the moved line. No-op at the bottom. */
  moveLineDown(): void {
    if (this.readOnly.value || !this.hasDocument.value) return;
    const line = this.cursor.line.value;
    if (line >= this.document.lineCount - 1) return; // bottom edge: nothing below to swap with
    this.captureBefore('other');
    const below = this.document.line(line + 1);
    const moved = this.document.line(line);
    this.document.setLine(line + 1, moved);
    this.document.setLine(line, below);
    this.placeCursor(line + 1, EditorCoordinates.Class.clampCol(moved, this.cursor.col.value));
    this.cursor.clearSelection();
    this.scrollLineIntoView(line + 1);
  }

  /** Copy the cursor's line and insert the copy directly below; the cursor follows onto the copy. */
  duplicateLine(): void {
    if (this.readOnly.value || !this.hasDocument.value) return;
    this.captureBefore('other');
    const line = this.cursor.line.value;
    const text = this.document.line(line);
    this.document.insertLine(line + 1, text);
    this.placeCursor(line + 1, EditorCoordinates.Class.clampCol(text, this.cursor.col.value));
    this.cursor.clearSelection();
    this.scrollLineIntoView(line + 1);
  }

  // --- clipboard ------------------------------------------------------------

  /** Copy the selection to the clipboard; returns the number of characters copied (0 = nothing). */
  async copySelection(): Promise<number> {
    const text = this.selectionText();
    if (text) await Clipboard.Class.copy(text);
    return text.length;
  }

  async cutSelection(): Promise<void> {
    if (this.readOnly.value || !this.hasDocument.value) return;
    const text = this.selectionText();
    if (!text) return;
    await Clipboard.Class.copy(text);
    this.captureBefore('delete');
    this.removeSelection();
    this.scrollLineIntoView(this.cursor.line.value);
  }

  async pasteClipboard(): Promise<void> {
    this.pasteText(await Clipboard.Class.paste());
  }

  /** Insert bulk text at the caret as ONE paste edit (replacing any selection, multiline-aware). Shared
   *  by clipboard paste and terminal bracketed-paste (dictation / Ctrl+V), so both coalesce identically
   *  under undo. */
  pasteText(text: string): void {
    if (this.readOnly.value || !this.hasDocument.value || !text) return;
    this.captureBefore('paste');
    this.removeSelection();
    const position = this.document.insertMultiline(this.cursor.line.value, this.cursor.col.value, text);
    this.placeCursor(position.line, position.col);
    this.scrollLineIntoView(position.line);
  }

  // --- undo/redo ------------------------------------------------------------

  performUndo(): void {
    const current = {
      lines: this.document.snapshot(),
      cursor: { line: this.cursor.line.value, col: this.cursor.col.value },
      kind: 'other' as EditKind,
      at: Clock.Class.now(),
    };
    const target = this.undo.undo(current);
    if (!target) return;
    this.document.restore(target.lines);
    // Content-aware dirty: an undo/redo that lands back on the saved content reads as UNCHANGED, not
    // dirty. (A normal edit always dirties eagerly; only undo/redo can return to the clean baseline.)
    this.document.dirty.value = !this.document.matchesSaved();
    this.placeCursor(target.cursor.line, target.cursor.col);
    this.cursor.clearSelection();
    this.scrollLineIntoView(target.cursor.line);
  }

  performRedo(): void {
    const current = {
      lines: this.document.snapshot(),
      cursor: { line: this.cursor.line.value, col: this.cursor.col.value },
      kind: 'other' as EditKind,
      at: Clock.Class.now(),
    };
    const target = this.undo.redo(current);
    if (!target) return;
    this.document.restore(target.lines);
    // Content-aware dirty: an undo/redo that lands back on the saved content reads as UNCHANGED, not
    // dirty. (A normal edit always dirties eagerly; only undo/redo can return to the clean baseline.)
    this.document.dirty.value = !this.document.matchesSaved();
    this.placeCursor(target.cursor.line, target.cursor.col);
    this.cursor.clearSelection();
    this.scrollLineIntoView(target.cursor.line);
  }

  save(): boolean {
    if (!this.hasDocument.value || !this.document.path) return false;
    Files.Class.write(this.document.path, this.document.text);
    this.document.markSaved();
    return true;
  }

  get title(): string {
    if (!this.hasDocument.value) return 'Editor';
    const name = this.document.path ? Files.Class.basename(this.document.path) : 'untitled';
    return this.document.dirty.value ? `${name} ●` : name;
  }

  // --- movement (extend = shift-select) -------------------------------------

  private currentLineLength(): number {
    return EditorCoordinates.Class.graphemeCount(this.document.line(this.cursor.line.value));
  }

  moveVertical(delta: number, extend = false): void {
    this.beginMove(extend);
    if (this.wordWrap.value) {
      // Wrap mode: vertical movement steps VISUAL rows; the goal is the visual column within the
      // wrapped row (set by placeCursor) and survives the run.
      const target = EditorWrap.Class.moveByVisualRows(
        this.document,
        { line: this.cursor.line.value, col: this.cursor.col.value },
        this.cursor.goalColumn.value,
        delta,
        this.wrapWidth(),
      );
      this.cursor.moveToLineKeepingGoal(target.line, target.col);
      this.revealCursorWrapped();
      return;
    }
    const target = this.cursor.line.value + delta;
    const maxLine = this.document.lineCount - 1;
    const clamped = Math.max(0, Math.min(target, maxLine));
    const landingColumn = EditorCoordinates.Class.graphemeAtDisplayColumn(this.document.line(clamped), this.cursor.goalColumn.value);
    this.cursor.moveToLineKeepingGoal(clamped, landingColumn);
    this.viewport.scrollToColumn(EditorCoordinates.Class.displayColumn(this.document.line(clamped), landingColumn));
    this.scrollLineIntoView(clamped);
  }

  moveHorizontal(delta: number, extend = false): void {
    this.beginMove(extend);
    let line = this.cursor.line.value;
    let column = this.cursor.col.value + delta;
    if (column < 0) {
      if (line > 0) {
        line -= 1;
        column = EditorCoordinates.Class.graphemeCount(this.document.line(line));
      } else {
        column = 0;
      }
    } else if (column > this.currentLineLength()) {
      if (line < this.document.lineCount - 1) {
        line += 1;
        column = 0;
      } else {
        column = this.currentLineLength();
      }
    }
    this.placeCursor(line, column);
    this.scrollLineIntoView(line);
  }

  /** Ctrl+Left/Right: jump to the previous/next word start (grapheme-safe). */
  moveWordHorizontal(direction: -1 | 1, extend = false): void {
    if (!this.hasDocument.value) return;
    this.beginMove(extend);
    if (direction < 0) {
      const target = this.previousWordPosition(false);
      this.placeCursor(target.line, target.col);
      this.scrollLineIntoView(target.line);
      return;
    }

    const isWordCharacter = (cluster: string): boolean => /[\p{L}\p{N}_]/u.test(cluster);
    let line = this.cursor.line.value;
    let column = this.cursor.col.value;
    const clusters = () => EditorCoordinates.Class.graphemes(this.document.line(line));
    let lineClusters = clusters();
    if (column >= lineClusters.length) {
      if (line >= this.document.lineCount - 1) return;
      line += 1;
      column = 0;
      lineClusters = clusters();
    } else {
      while (column < lineClusters.length && isWordCharacter(lineClusters[column] ?? '')) column += 1;
    }
    while (column < lineClusters.length && !isWordCharacter(lineClusters[column] ?? '')) column += 1;
    this.placeCursor(line, column);
    this.scrollLineIntoView(line);
  }

  /**
   * Convert the shared string boundary back into an editor line/grapheme position. The local text
   * window includes only the preceding line and current prefix: enough to represent the newline
   * boundary without materializing the document, so cost is independent of document length.
   */
  private previousWordPosition(useDeletionRange: boolean): { line: number; col: number } {
    const currentLineIndex = this.cursor.line.value;
    const currentLineText = this.document.line(currentLineIndex);
    const currentPrefixEndUtf16Offset = EditorCoordinates.Class.graphemeToU16(
      currentLineText,
      this.cursor.col.value,
    );
    const currentPrefix = currentLineText.slice(0, currentPrefixEndUtf16Offset);
    const previousLineText = currentLineIndex > 0 ? this.document.line(currentLineIndex - 1) : '';
    const currentLineStart = currentLineIndex > 0
      ? EditorCoordinates.Class.graphemeCount(previousLineText) + 1
      : 0;
    const localText = currentLineIndex > 0
      ? `${previousLineText}\n${currentPrefix}`
      : currentPrefix;
    const localCursor = EditorCoordinates.Class.graphemeCount(localText);
    const localStart = useDeletionRange
      ? TextEditing.Class.deletePreviousWord(localText, localCursor).start
      : TextEditing.Class.wordLeft(localText, localCursor);

    if (currentLineIndex > 0 && localStart < currentLineStart) {
      return { line: currentLineIndex - 1, col: localStart };
    }
    return { line: currentLineIndex, col: localStart - currentLineStart };
  }

  /** Ctrl+Home / Ctrl+End: jump to the document start/end. */
  moveDocumentStart(extend = false): void {
    if (!this.hasDocument.value) return;
    this.beginMove(extend);
    this.placeCursor(0, 0);
    this.scrollLineIntoView(0);
  }
  moveDocumentEnd(extend = false): void {
    if (!this.hasDocument.value) return;
    this.beginMove(extend);
    const lastLine = this.document.lineCount - 1;
    this.placeCursor(lastLine, EditorCoordinates.Class.graphemeCount(this.document.line(lastLine)));
    this.scrollLineIntoView(lastLine);
  }

  moveToLineStart(extend = false): void {
    this.beginMove(extend);
    this.placeCursor(this.cursor.line.value, 0);
  }
  moveToLineEnd(extend = false): void {
    this.beginMove(extend);
    this.placeCursor(this.cursor.line.value, this.currentLineLength());
  }
  pageDown(extend = false): void {
    this.moveVertical(this.viewport.height.value - 1, extend);
  }
  pageUp(extend = false): void {
    this.moveVertical(-(this.viewport.height.value - 1), extend);
  }
  gotoTop(extend = false): void {
    this.beginMove(extend);
    this.placeCursor(0, 0);
    this.scrollLineIntoView(0);
  }
  gotoBottom(extend = false): void {
    this.beginMove(extend);
    const last = this.document.lineCount - 1;
    this.placeCursor(last, 0);
    this.scrollLineIntoView(last);
  }
}

export namespace Editor {
  export const $Class = $Editor;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
