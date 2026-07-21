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
import { graphemeCount } from './editor.coordinates';
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

  openFile(path: string): void {
    this.document.loadFromFile(path);
    this.cursor.set(0, 0);
    this.cursor.clearSelection();
    this.viewport.scrollTop.value = 0;
    this.hasDocument.value = true;
    this.readOnly.value = this.document.binary.value;
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
    this.cursor.set(0, 0);
    this.cursor.setAnchorHere();
    this.cursor.set(last, graphemeCount(this.document.line(last)));
  }

  /** Delete the active selection (no undo capture — caller captures). Returns whether it removed. */
  private removeSelection(): boolean {
    const range = this.cursor.selectionRange();
    if (!range) return false;
    const position = this.document.deleteRange(range.start, range.end);
    this.cursor.set(position.line, position.col);
    this.cursor.clearSelection();
    return true;
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
    this.cursor.set(this.cursor.line.value, column);
    this.viewport.scrollToLine(this.cursor.line.value, this.document.lineCount);
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
      this.cursor.set(position.line, column);
    } else {
      this.cursor.set(position.line, position.col);
    }
    this.viewport.scrollToLine(this.cursor.line.value, this.document.lineCount);
  }

  backspace(): void {
    if (this.readOnly.value || !this.hasDocument.value) return;
    this.captureBefore('delete');
    if (this.removeSelection()) {
      this.viewport.scrollToLine(this.cursor.line.value, this.document.lineCount);
      return;
    }
    const position = this.document.deleteBackward(this.cursor.line.value, this.cursor.col.value);
    this.cursor.set(position.line, position.col);
    this.viewport.scrollToLine(position.line, this.document.lineCount);
  }

  deleteChar(): void {
    if (this.readOnly.value || !this.hasDocument.value) return;
    this.captureBefore('delete');
    if (this.removeSelection()) return;
    this.document.deleteForward(this.cursor.line.value, this.cursor.col.value);
  }

  // --- clipboard ------------------------------------------------------------

  async copySelection(): Promise<void> {
    const text = this.selectionText();
    if (text) await Clipboard.Class.copy(text);
  }

  async cutSelection(): Promise<void> {
    if (this.readOnly.value || !this.hasDocument.value) return;
    const text = this.selectionText();
    if (!text) return;
    await Clipboard.Class.copy(text);
    this.captureBefore('delete');
    this.removeSelection();
    this.viewport.scrollToLine(this.cursor.line.value, this.document.lineCount);
  }

  async pasteClipboard(): Promise<void> {
    if (this.readOnly.value || !this.hasDocument.value) return;
    const text = await Clipboard.Class.paste();
    if (!text) return;
    this.captureBefore('insert');
    this.removeSelection();
    const position = this.document.insertMultiline(this.cursor.line.value, this.cursor.col.value, text);
    this.cursor.set(position.line, position.col);
    this.viewport.scrollToLine(position.line, this.document.lineCount);
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
    this.cursor.set(target.cursor.line, target.cursor.col);
    this.cursor.clearSelection();
    this.viewport.scrollToLine(target.cursor.line, this.document.lineCount);
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
    this.cursor.set(target.cursor.line, target.cursor.col);
    this.cursor.clearSelection();
    this.viewport.scrollToLine(target.cursor.line, this.document.lineCount);
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
    const target = this.cursor.line.value + delta;
    const maxLine = this.document.lineCount - 1;
    const clamped = Math.max(0, Math.min(target, maxLine));
    this.cursor.setLinePreserveGoal(clamped, graphemeCount(this.document.line(clamped)));
    this.viewport.scrollToLine(clamped, this.document.lineCount);
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
    this.cursor.set(line, column);
    this.viewport.scrollToLine(line, this.document.lineCount);
  }

  moveToLineStart(extend = false): void {
    this.beginMove(extend);
    this.cursor.set(this.cursor.line.value, 0);
  }
  moveToLineEnd(extend = false): void {
    this.beginMove(extend);
    this.cursor.set(this.cursor.line.value, this.currentLineLength());
  }
  pageDown(extend = false): void {
    this.moveVertical(this.viewport.height.value - 1, extend);
  }
  pageUp(extend = false): void {
    this.moveVertical(-(this.viewport.height.value - 1), extend);
  }
  gotoTop(extend = false): void {
    this.beginMove(extend);
    this.cursor.set(0, 0);
    this.viewport.scrollToLine(0, this.document.lineCount);
  }
  gotoBottom(extend = false): void {
    this.beginMove(extend);
    const last = this.document.lineCount - 1;
    this.cursor.set(last, 0);
    this.viewport.scrollToLine(last, this.document.lineCount);
  }
}

export namespace Editor {
  export const $Class = $Editor;
  export let Class = Reactive($Class);
  export type Instance = typeof Class.Instance;
}
