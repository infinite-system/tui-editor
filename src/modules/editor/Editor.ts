// The editor: owns a document, a cursor, and a viewport, and coordinates movement, selection,
// editing, and scroll.
//
// invariant: Data flows one way (project.invariants.md)
// invariant: Selection is an anchor plus the cursor and edits replace it (editor.invariants.md)
import { Reactive } from 'ivue';
import { ref } from 'vue';
import { TextDocument } from './TextDocument';
import { Viewport } from './Viewport';
import { Cursor } from './Cursor';
import { graphemeCount, displayColumn, graphemeAtDisplayColumn, graphemes } from './editor.coordinates';
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
  get wordWrap() {
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

  /** Wrap-mode reveal: the smallest logical-scrollTop change that shows the cursor's VISUAL row. */
  private revealCursorWrapped(): void {
    const width = this.wrapWidth();
    const segments = EditorWrap.Class.wrapLine(this.document.line(this.cursor.line.value), width);
    const segmentIndex = EditorWrap.Class.segmentIndexForCursor(segments, this.cursor.col.value);
    this.viewport.scrollTop.value = EditorWrap.Class.scrollTopToRevealCursor(
      this.document,
      this.viewport.scrollTop.value,
      this.cursor.line.value,
      segmentIndex,
      width,
      this.viewport.height.value,
    );
  }

  /** Mode-aware vertical reveal: wrapped visual-row walk when wrap is on, logical otherwise. */
  private scrollLineIntoView(line: number): void {
    if (this.wordWrap.value) this.revealCursorWrapped();
    else this.viewport.scrollToLine(line, this.document.lineCount);
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
    this.placeCursor(last, graphemeCount(this.document.line(last)));
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
    const absoluteDisplayColumn = displayColumn(lineText, column);
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
    if (this.readOnly.value || !this.hasDocument.value) return;
    const text = await Clipboard.Class.paste();
    if (!text) return;
    this.captureBefore('insert');
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
    this.document.dirty.value = true;
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
    this.document.dirty.value = true;
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
    return graphemeCount(this.document.line(this.cursor.line.value));
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
    const landingColumn = graphemeAtDisplayColumn(this.document.line(clamped), this.cursor.goalColumn.value);
    this.cursor.moveToLineKeepingGoal(clamped, landingColumn);
    this.viewport.scrollToColumn(displayColumn(this.document.line(clamped), landingColumn));
    this.scrollLineIntoView(clamped);
  }

  moveHorizontal(delta: number, extend = false): void {
    this.beginMove(extend);
    let line = this.cursor.line.value;
    let column = this.cursor.col.value + delta;
    if (column < 0) {
      if (line > 0) {
        line -= 1;
        column = graphemeCount(this.document.line(line));
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
    const isWordCharacter = (cluster: string): boolean => /[\p{L}\p{N}_]/u.test(cluster);
    let line = this.cursor.line.value;
    let column = this.cursor.col.value;
    const clusters = () => graphemes(this.document.line(line));
    if (direction > 0) {
      let row = clusters();
      if (column >= row.length) {
        if (line >= this.document.lineCount - 1) return;
        line += 1;
        column = 0;
        row = clusters();
      } else {
        while (column < row.length && isWordCharacter(row[column] ?? '')) column += 1;
      }
      while (column < row.length && !isWordCharacter(row[column] ?? '')) column += 1;
    } else {
      let row = clusters();
      if (column === 0) {
        if (line === 0) return;
        line -= 1;
        row = clusters();
        column = row.length;
      }
      while (column > 0 && !isWordCharacter(row[column - 1] ?? '')) column -= 1;
      while (column > 0 && isWordCharacter(row[column - 1] ?? '')) column -= 1;
    }
    this.placeCursor(line, column);
    this.scrollLineIntoView(line);
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
    this.placeCursor(lastLine, graphemeCount(this.document.line(lastLine)));
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
